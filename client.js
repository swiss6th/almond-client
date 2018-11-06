"use strict"

//process.env.DEBUG = '*'
//delete process.env.DEBUG

const WebSocket = require('ws'),
	EventEmitter = require('events').EventEmitter,
	debug = require('debug')('almond-client'),
	randomstring = require("randomstring"),
	devicePersonalities = require("./devicePersonalities")

class AlmondWebSocket extends EventEmitter {
	constructor(url) {
		super()

		this.KEEPALIVE_INTERVAL_MS = 1000
		this.RECONNECT_WAIT_MS = 977

		this.PULSE_TIMEOUT_MS = 1100

		this.SEND_TIMEOUT_MS = 1982
		this.MAX_SEND_RETRIES = 10

		this.ws = null
		this.heartbeat = null
		this.isConnected = false

		this.url = url
		this._open(this.url)
	}

	_parseAlmondValue(value) { // Convert type of received value
		if (typeof value === 'string') {
			if (value === 'true' || value === 'false') {
				value = value == 'true'
			} else if (value !== '' && Number(value) == value) {
				value = Number(value)
			}
		}
		return value
	}

	_parseAlmondObject(object) { // Convert type of object received from Almond+
		for (let key in object) {
			const value = object[key]
			if (typeof value === "object" && value !== null) {
				this._parseAlmondObject(value)
			} else {
				object[key] = this._parseAlmondValue(value)
			}
		}
	}

	_formatObject(object) { // Convert type of object to be sent to Almond+
		for (let key in object) {
			const value = object[key]
			if (typeof value === "object" && value !== null) {
				this._formatObject(value)
			} else {
				object[key] = String(value)
			}
		}
	}

	_open(url) {
		debug("opening WebSocket")
		this.ws = new WebSocket(url)
		this.ws.on('error', this._onError.bind(this))
		this.ws.on('close', this._onClose.bind(this))
		this.ws.on('open', this._onOpen.bind(this))
		this.ws.on('message', this._receive.bind(this))
	}

	_onError(error) {
		debug("encountered WebSocket error", error)
	}

	_onOpen() {
		clearTimeout(this.pulse)

		debug("WebSocket opened")
		this._startKeepAlive()
		this.emit("open")

		if (!this.isConnected) {
			this.isConnected = true
			this.emit("up")
		}
	}

	_onClose() {
		debug("WebSocket closed")
		setTimeout(this._reconnect.bind(this), this.RECONNECT_WAIT_MS)
		this.emit("close")

		this.pulse = setTimeout( () => {
			if (this.isConnected) {
				this.isConnected = false
				this.emit("down")
			}
		}, this.PULSE_TIMEOUT_MS)
	}

	_startKeepAlive() {
		debug("starting keepalive")
		this.ws.isAlive = true
		this.ws.removeAllListeners('pong')
		this.ws.on('pong', () => this.ws.isAlive = true)

		clearInterval(this.heartbeat)
		this.heartbeat = setInterval( () => {
			if (this.ws.isAlive === false) {
				debug("WebSocket died; terminating it")
				clearInterval(this.heartbeat)
				this.ws.terminate()
				return
			}

			this.ws.isAlive = false
			this.ws.ping(() => {})
		}, this.KEEPALIVE_INTERVAL_MS)
	}

	_stopKeepAlive() {
		debug("stopping keepalive")
		clearInterval(this.heartbeat)
		this.ws.removeAllListeners('pong')
	}

	_reconnect() {
		debug("attempting reconnect")
		this._open(this.url)
	}

	_receive(message) {
		const json = JSON.parse(message)
		this._parseAlmondObject(json)
		
		debug("received message", json)

		const mii = json["MobileInternalIndex"]

		if (typeof mii === "undefined") {
			debug("received dynamic message")
			this.emit("dynamicMessage", json)
		} else {
			debug("received response")
			this.emit(mii, null, json)
		}
	}

	send(json, cb, retries) {
		this._formatObject(json)
		const mii = randomstring.generate()
		json["MobileInternalIndex"] = mii
		let msg = JSON.stringify(json)

		if (retries === undefined) retries = this.MAX_SEND_RETRIES

		const sendTimer = setTimeout( () => {
			debug("didn't hear back from server")
			if (retries > 0) {
				debug("retrying send")
				this.send(json, cb, --retries)
			} else {
				debug("exhausted send retries; aborting send")
				if (cb) cb(1)
			}
		}, this.SEND_TIMEOUT_MS)

		this.ws.send(msg, err => {
			if (err) {
				if (cb) cb(err)
				debug("couldn't send message", msg, err)
			} else {
				clearTimeout(sendTimer)
				if (cb) this.on(mii, cb.bind(this))
				debug("sent message", msg)
			}
		})
	}
}

class AlmondDevice extends EventEmitter {
	constructor(client, config) {
		super()

		this.client = client

		this._setDeviceInfo(config.Data)

		this.personality = devicePersonalities[this.type]
		this.props = this._getPropertyList(this.personality.DeviceProperties)

		this._deviceValues = {}
		this._setDeviceValues(config.DeviceValues)
	}

	_getPropertyList(properties) {
		const list = {}
		for (let prop in properties) {
			list[properties[prop].Name] = Number(prop)
		}
		return list
	}

	_setDeviceInfo(data, forceUpdate = false) {
		if (
			forceUpdate
			|| this.id !== data.ID
			|| this.name !== data.Name
			|| this.type !== data.Type
			|| this.location !== data.Location
			|| this.manufacturer !== data.Manufacturer
			|| this.model !== data.Model			
		) {
			this.id = data.ID
			this.name = data.Name
			this.type = data.Type
			this.location = data.Location
			this.manufacturer = data.Manufacturer || "Unknown Manufacturer"
			this.model = data.Model || "Unknown Model"
			return true
		}
		return false
	}

	_setDeviceValues(values) {
		const deviceProperties = this.personality.DeviceProperties
		for (let index in values) {
			let updateFrequency = index in deviceProperties ? deviceProperties[index].UpdateFrequency : undefined
			this._deviceValues[index] = {
				index: Number(index),
				name: values[index].Name,
				value: values[index].Value,
				update: updateFrequency || "onChange"
			}
		}
	}

	_updateDeviceValues(values, forceUpdate = false) {
		for (let index in values) {
			if (index in this._deviceValues) {
				this._updateDeviceValue(index, values[index].Value, forceUpdate)
			}
		}
	}

	_updateDeviceValue(index, value, forceUpdate = false) {
		const property = this._deviceValues[index]
		if (typeof property === "undefined") return
		switch (property.update) {
			case "always":
				break
			case "onTrigger":
				if (!forceUpdate) return
				break
			case "onChange":
			default:
				if (property.value === value) return
		}

		debug(`updating device value ${index} from ${property.value} to ${value}`)
		property.value = value
		this.emit("valueUpdated", Number(index), value)
	}

	setProp(index, value, cb) {
		if (value == this._deviceValues[index].value) {
			if (cb) cb(value)
			return
		}

		const self = this

		this.client.send({
			"CommandType": "UpdateDeviceIndex",
			"ID": this.id,
			"Index": index,
			"Value": value
		}, (err, message) => {
			if (err) {
				if (cb) return cb(err)
				return err
			}
			if (message && message.Success) {
				debug(`successfully sent device value [${index}] update [${value}]`)
				const waitForDeviceValueUpdate = function(indexUpdated, newValue) {
					if (indexUpdated == index) {
						self.removeListener('valueUpdated', waitForDeviceValueUpdate)
						cb(newValue)
					}
				}
				if (cb) self.prependListener('valueUpdated', waitForDeviceValueUpdate)
			}
		})
	}

	getProp(index) {
		const deviceValue = this._deviceValues[index]
		return deviceValue !== undefined && deviceValue.value !== undefined ? deviceValue.value : undefined
	}

	addValueUpdatedListener(listener) {
		this.on('valueUpdated', listener)
	}
}

module.exports = class AlmondClient extends EventEmitter {
	constructor(config) {
		super()

		if (config === undefined) {
			debug("didn't receive config from caller")
			return
		}

		this._devices = {}

		const {host, port = 7681, username = "root", password} = config

		const url = `ws://${host}:${port}/${username}/${password}`
		this.almondWs = new AlmondWebSocket(url)
		this.almondWs.on("open", this._getDeviceList.bind(this))
		this.almondWs.on("up", () => this.emit("connected"))
		this.almondWs.on("down", () => this.emit("disconnected"))
		this.almondWs.on("dynamicMessage", this._processDynamicMessage.bind(this))

		this.once("gotDeviceList", () => this.emit("ready"))
	}

	_getDeviceList() {
		this.send({
			"CommandType": "DeviceList"
		}, (err, message) => {
			if (err) {
				debug("couldn't get device list")
				return
			}
			this._processDeviceUpdate(message)
			this.emit("gotDeviceList")
		})
	}

	_processDynamicMessage(message) {
		debug("got dynamicMessage", message)

		switch (message.CommandType) {
			case "DynamicIndexUpdated":
				this._processIndexUpdate(message, true)
				break
			case "DynamicDeviceAdded":
			case "DynamicDeviceUpdated":
				this._processDeviceUpdate(message)
				break
			case "DynamicDeviceRemoved":
				this._processDeviceRemoval(message)
				break
			default:
				debug("didn't understand message")
		}
	}

	_processIndexUpdate(message, forceUpdate = false) {
		const devices = message.Devices
		for (let id in devices) {
			if (id in this._devices) {
				this._updateIndex(id, devices[id], forceUpdate)
			} else {
				this._getDeviceList()
			}
		}
	}

	_processDeviceUpdate(message, forceUpdate = false) {
		const devices = message.Devices
		for (let id in devices) {
			if (id in this._devices) {
				this._updateDevice(id, devices[id], forceUpdate)
			} else {
				this._addDevice(id, devices[id])
			}
		}
	}

	_processDeviceRemoval(message) {
		const devices = message.Devices
		for (let id in devices) {
			if (id in this._devices && this._devices[id].type == devices[id].Type) {
				this._removeDevice(id)
			}
		}
	}

	_addDevice(id, message) {
		debug("adding device", message)
		const device = new AlmondDevice(this, message)

		this._devices[id] = device
		this.emit("deviceAdded", device)
	}

	_updateDevice(id, message, forceUpdate = false) {
		debug("updating device", message)
		const device = this._devices[id]

		device._updateDeviceValues(message.DeviceValues, forceUpdate)
		if (device._setDeviceInfo(message.Data)) {
			this.emit("deviceUpdated", device)
		}
	}

	_removeDevice(id) {
		debug("removing device", id)
		const device = this._devices[id]
		
		delete this._devices[id]
		this.emit("deviceRemoved", device)
	}

	_updateIndex(id, message, forceUpdate = false) {
		debug("updating device index", message)
		const device = this._devices[id]

		device._updateDeviceValues(message.DeviceValues, forceUpdate)
		this.emit("indexUpdated", device)
	}

	getDevices() {
		let devices = []
		for (let device in this._devices) {
			devices.push(this._devices[device])
		}
		return devices
	}

	getDeviceById(id) {
		return this._devices[id]
	}

	send(message, callback) {
		this.almondWs.send(message, callback)
	}
}