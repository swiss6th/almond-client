"use strict"

process.env.DEBUG = '*'
//delete process.env.DEBUG

global.WebSocket = require('ws')
//const WebSocket = require('websocket').w3cwebsocket
//const ReconnectingWebSocket = require('reconnecting-websocket')
const Sockette = require('sockette')
const EventEmitter = require('events').EventEmitter
const debug = require('debug')('almond-client')
const randomstring = require("randomstring")
const deviceProps = require("./deviceProperties.js")

/*
class WebSocketClient {
	constructor(url) {
		this.number = 0 // Message number
		this.autoReconnectInterval = 3 * 1000 // ms

		this.open(url)
	}

	open(url) {
		this.url = url
		this.instance = new WebSocket(this.url)

		this.instance.on('open', () => {
			this.onopen()
		})

		this.instance.on('message', (data, flags) => {
			this.number++
			this.onmessage(data, flags, this.number)
		})

		this.instance.on('close', (e) => {
			switch (e) {
				case 1000: // CLOSE_NORMAL
					console.log("WebSocket: closed")
					break
				default: // Abnormal closure
					this.reconnect(e)
			}
			this.onclose(e)
		})

		this.instance.on('error', (e) => {
			switch (e.code) {
				case 'ECONNREFUSED':
					this.reconnect(e)
					break
				default:
					this.onerror(e)
			}
		})
	}

	send(data, option) {
		try {
			this.instance.send(data, option)
		} catch (e) {
			this.instance.emit('error', e)
		}
	}

	reconnect(e) {
		console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e)
		setTimeout( () => {
			console.log("WebSocketClient: reconnecting...")
			this.open(this.url)
		}, this.autoReconnectInterval)
	}

	onopen(e) {
		console.log("WebSocketClient: open", arguments)
	}

	onmessage(data, flags, number) {
		console.log("WebSocketClient: message", arguments)
	}

	onerror(e) {
		console.log("WebSocketClient: error", arguments)
	}

	onclose(e) {
		console.log("WebSocketClient: closed", arguments)
	}
}
*/

module.exports = class AlmondClient extends EventEmitter {
	constructor(config) {
		super()

		if (config === undefined) {
			debug("didn't receive config from caller")
			return
		}

		this._SEND_TIMEOUT_MS = 2000
		this._MAX_CONNECTION_ATTEMPTS = 10
		this._connectionAttempts = 0
		this._sendTimers = []

		this._devices = {}

		this.host = config.host
		this.port = config.port
		this.username = config.username
		this.password = config.password

//		const rwsOptions = {
//			WebSocket: WebSocket,
//			debug: true
//		}

		this.url = `ws://${this.host}:${this.port}/${this.username}/${this.password}`
		this.ws = new WebSocket(this.url)
		this.ws.on('open', () => {
			this._getDeviceList()
			this.once("gotDeviceList", () => this.emit("ready"))
		})
		this.ws.on('message', this._recvMessage.bind(this))

/*
		this.ws = new Sockette(url, {
			onopen: () => {
				this._getDeviceList()
				this.attachUpdateListeners()
				this.once("gotDeviceList", () => this.emit("ready"))
			},
			onmessage: e => {
				this._recvMessage(e)
			},
			onerror: e => {
				console.log("Something bad happened:", e)
			}
		})
*/

//		this.ws = new ReconnectingWebSocket(url, [], rwsOptions) // new WebSocket(url)
//		this.ws.binaryType = "arraybuffer"
		this.wsEmitter = new WebSocketEmitter()

		this.wsEmitter.on("dynamicMessage", this._processDynamicMessage.bind(this))
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

	_getDeviceList() {
		this._sendMessage({
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
		for (let deviceID in devices) {
			this._processDeviceValues(deviceID, devices[deviceID])
		}
	}

	_processDeviceValues(devID, devData) {
		const deviceValues = devData.DeviceValues
		const device = this._devices[devID]

		for (let index in deviceValues) {
			device.updateProp(index, deviceValues[index].Value)
		}
	}

	_addDevice(devData) {
		debug("adding device", devData)
		const device = new AlmondDevice(this, devData)

		this._devices[device.id] = device
		this.emit("deviceAdded", device)
	}

	_updateDevice(devData) {
		debug("updating device", devData)
		const devId = devData.Data.ID
		const device = this._devices[devId]

		this._processDeviceValues(devId, devData)
		this.emit("deviceUpdated", device)
	}

	_sendMessage(json, cb) {
		const mii = randomstring.generate()
		json["MobileInternalIndex"] = mii
		let msg = JSON.stringify(json)

		const sendTimer = setTimeout( () => {
			debug("didn't hear back from server")
			this.ws.close(1011, "No response from server")
			if (this._connectionAttempts < this._MAX_CONNECTION_ATTEMPTS) {
				debug("reconnecting")
				this._connectionAttempts++
				this.ws = new WebSocket(this.url)
				this.ws.once('open', () => {
					debug("reconnected to server; retrying send")
					this._sendMessage(json, cb)
					this._getDeviceList()
				})
				this.ws.on('message', this._recvMessage.bind(this))
			} else {
				debug("exhausted connection retries; aborting reconnect and send")
				this._connectionAttempts = 0
				if (cb) cb(1)
			}
		}, this._SEND_TIMEOUT_MS)

		this.ws.send(msg, err => {
			if (err) {
				if (cb) cb(err)
				debug("couldn't send message", msg, err)
			} else {
				clearTimeout(sendTimer)
				if (cb) this.wsEmitter.on(mii, cb.bind(this))
				debug("sent message", msg)
			}
		})
	}

	_recvMessage(message) {
		debug("received message", message)

		const json = JSON.parse(message)
		const mii = json["MobileInternalIndex"]

		if (typeof mii === "undefined") {
			debug("got dynamic message")
			this.wsEmitter.emit("dynamicMessage", json)
		} else {
			this.wsEmitter.emit(mii, null, json)
		}
	}

/*
	attachUpdateListeners() {
		const devices = this._devices
		for (let deviceId in devices) {
			let device = devices[deviceId]
			for (let listener of device.updateListeners) {
				device.on('valueUpdated', (prop, value) => listener(prop, value))
			}
		}
	}
*/
}

class AlmondDevice extends EventEmitter {
	constructor(client, config) {
		super()

		this.client = client

		this.id = Number(config.Data.ID)
		this.name = config.Data.Name
		this.type = Number(config.Data.Type)
		this.location = config.Data.Location
		this.manufacturer = config.Data.Manufacturer || "Unknown Manufacturer"
		this.model = config.Data.Model || "Unknown Model"

		this.props = deviceProps[this.type]

		this._deviceValues = {}

		for (let id in config.DeviceValues) {
			this._deviceValues[id] = {
				id: Number(id),
				name: config.DeviceValues[id].Name,
				value: this.parseAlmondValue(config.DeviceValues[id].Value)
			}
		}

		this.updateListeners = []
	}

	parseAlmondValue(value) { // Convert type, as Almond+ encodes every value as a string
		if (typeof value === 'string') {
			if (value === 'true' || value === 'false') {
				value = value == 'true'
			} else if (value !== '' && Number(value) == value) {
				value = Number(value)
			}
		}
		return value
	}

	setProp(prop, value, cb) {
		if (value == this._deviceValues[prop].value) {
			if (cb) cb(value)
			return
		}

		const self = this

		this.client._sendMessage({
			"CommandType": "UpdateDeviceIndex",
			"ID": String(this.id), // Almond+ encodes every value as a string
			"Index": String(prop), // Almond+ encodes every value as a string
			"Value": String(value) // Almond+ encodes every value as a string
		}, (err, message) => {
			if (err) {
				if (cb) return cb(err)
				return err
			}
			if (message && message.Success && message.Success == 'true') {
				debug(`successfully sent property [${prop}] update [${value}]`)
				const waitForDevicePropUpdate = function(propUpdated, newValue) {
					if (propUpdated == prop) {
						self.removeListener('valueUpdated', waitForDevicePropUpdate)
						cb(self.parseAlmondValue(newValue))
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

	updateProp(prop, value) {
		prop = Number(prop)
		value = this.parseAlmondValue(value)
		if (typeof this._deviceValues[prop] === "undefined") return
		if (this._deviceValues[prop].value === value) return

		debug(`updating value ${prop} from ${this._deviceValues[prop].value} to ${value}`)
		this._deviceValues[prop].value = value
		this.emit("valueUpdated", prop, value)
	}

	addUpdateListener(listener) {
		this.updateListeners.push(listener)
		this.on('valueUpdated', listener)
	}
}

class WebSocketEmitter extends EventEmitter {
	constructor() {
		super()
	}
}