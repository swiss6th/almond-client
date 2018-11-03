"use strict"

process.env.DEBUG = '*'
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
		this.RECONNECT_WAIT_MS = 1000
		this.SEND_TIMEOUT_MS = 2000
		this.MAX_SEND_RETRIES = 10

		this.ws = null
		this.heartbeat = null

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
		this.ws.on('error', e => debug("encountered WebSocket error", e))
		this.ws.on('close', this._onClose.bind(this))
		this.ws.on('open', this._onOpen.bind(this))
		this.ws.on('message', this._receive.bind(this))
	}

	_onOpen() {
		debug("WebSocket opened")
		this._startKeepAlive()
		this.emit("open")
	}

	_onClose() {
		debug("WebSocket closed")
		setTimeout(this._reconnect.bind(this), this.RECONNECT_WAIT_MS)
		this.emit("close")
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

		this.id = config.Data.ID
		this.name = config.Data.Name
		this.type = config.Data.Type
		this.location = config.Data.Location
		this.manufacturer = config.Data.Manufacturer || "Unknown Manufacturer"
		this.model = config.Data.Model || "Unknown Model"

		const personality = devicePersonalities[this.type]
		this.props = this._getProperties(personality)

		this._deviceValues = {}

		const values = config.DeviceValues
		for (let id in values) {
			this._deviceValues[id] = {
				id: Number(id),
				name: values[id].Name,
				value: values[id].Value,
				update: id in personality.DeviceProperties
					? personality.DeviceProperties[id].ShouldAlwaysUpdate
					: false
			}
		}
	}

	_getProperties(personality) {
		const props = {}
		for (let prop in personality.DeviceProperties) {
			props[personality.DeviceProperties[prop].Name] = Number(prop)
		}
		return props
	}

	_updateProp(prop, value) {
		if (typeof this._deviceValues[prop] === "undefined") return
		if (!this._deviceValues[prop].update && this._deviceValues[prop].value === value) return

		debug(`updating property ${prop} from ${this._deviceValues[prop].value} to ${value}`)
		this._deviceValues[prop].value = value
		this.emit("valueUpdated", prop, value)
	}

	setProp(prop, value, cb) {
		if (value == this._deviceValues[prop].value) {
			if (cb) cb(value)
			return
		}

		const self = this

		this.client.send({
			"CommandType": "UpdateDeviceIndex",
			"ID": this.id,
			"Index": prop,
			"Value": value
		}, (err, message) => {
			if (err) {
				if (cb) return cb(err)
				return err
			}
			if (message && message.Success) {
				debug(`successfully sent property [${prop}] update [${value}]`)
				const waitForDevicePropUpdate = function(propUpdated, newValue) {
					if (propUpdated == prop) {
						self.removeListener('valueUpdated', waitForDevicePropUpdate)
						cb(newValue)
					}
				}
				if (cb) self.prependListener('valueUpdated', waitForDevicePropUpdate)
			}
		})
	}

	getProp(prop) {
		const deviceProp = this._deviceValues[prop]
		return deviceProp !== undefined ? deviceProp.value : undefined
	}

	addUpdateListener(listener) {
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
		this.almondWs.on("dynamicMessage", this._processDynamicMessage.bind(this))

		this.once("gotDeviceList", () => this.emit("ready"))
	}

	_getDeviceList() {
		this.almondWs.send({
			"CommandType": "DeviceList"
		}, (err, data) => {
			let devices = data.Devices
			for (let deviceId in devices) {
				if (!(deviceId in this._devices)) {
					this._addDevice(devices[deviceId])
				} else {
					this._updateDevice(devices[deviceId])
				}
			}
			this.emit("gotDeviceList")
		})
	}

	_processDynamicMessage(message) {
		debug("got dynamicMessage", message)

		switch(message.CommandType) {
			case "DynamicIndexUpdated":
				this._processDeviceUpdate(message)
				break
			default:
				debug("didn't understand message")
		}
	}

	_processDeviceUpdate(message) {
		debug("got device update message", message)
		const devices = message.Devices
		for (let deviceId in devices) {
			this._processDeviceValues(deviceId, devices[deviceId])
		}
	}

	_processDeviceValues(deviceId, deviceData) {
		const deviceValues = deviceData.DeviceValues
		const device = this._devices[deviceId]

		for (let prop in deviceValues) {
			device._updateProp(Number(prop), deviceValues[prop].Value)
		}
	}

	_addDevice(deviceData) {
		debug("adding device", deviceData)
		const device = new AlmondDevice(this, deviceData)

		this._devices[device.id] = device
		this.emit("deviceAdded", device)
	}

	_updateDevice(deviceData) {
		debug("updating device", deviceData)
		const deviceId = deviceData.Data.ID
		const device = this._devices[deviceId]

		this._processDeviceValues(deviceId, deviceData)
		this.emit("deviceUpdated", device)
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