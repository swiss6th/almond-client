"use strict";

const util = require('util');
const WebSocket = require('ws');
const EventEmitter = require('events').EventEmitter;
const debug = require('debug')('almond-client');
const randomstring = require("randomstring");
const deviceProps = require("./deviceProperties.js");	

class WebSocketClient {
	constructor() {
		this.number = 0; // Message number
		this.autoReconnectInterval = 5 * 1000; // ms
	}

	open(url) {
		this.url = url;
		this.instance = new WebSocket(this.url);

		this.instance.on('open', () => {
			this.onopen();
		});

		this.instance.on('message', (data, flags) => {
			this.number++;
			this.onmessage(data, flags, this.number);
		});

		this.instance.on('close', (e) => {
			switch (e) {
				case 1000: // CLOSE_NORMAL
					console.log("WebSocket: closed");
					break;
				default: // Abnormal closure
					this.reconnect(e);
			}
			this.onclose(e);
		});

		this.instance.on('error', (e) => {
			switch (e.code) {
				case 'ECONNREFUSED':
					this.reconnect(e);
					break;
				default:
					this.onerror(e);
			}
		});
	}

	send(data, option) {
		try {
			this.instance.send(data, option);
		} catch (e) {
			this.instance.emit('error', e);
		}
	}

	reconnect(e) {
		console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);
		setTimeout( () => {
			console.log("WebSocketClient: reconnecting...");
			this.open(this.url);
		}, this.autoReconnectInterval);
	}

	onopen(e) {
		console.log("WebSocketClient: open", arguments);
	}

	onmessage(data, flags, number) {
		console.log("WebSocketClient: message", arguments);
	}

	onerror(e) {
		console.log("WebSocketClient: error", arguments);
	}

	onclose(e) {
		console.log("WebSocketClient: closed", arguments);
	}
}

module.exports = class AlmondClient extends EventEmitter {
	constructor(config) {
		super();

		this.host = config.host;
		this.port = config.port;

		this.username = config.username;
		this.password = config.password;

		let url = util.format("ws://%s:%s/%s/%s", this.host, this.port, this.username, this.password)
		this.ws = new WebSocket(url);
		this.wsEmitter = new WebSocketEmitter();

		this._devices = {};

		this.ws.on('open', () => {
			this._getDeviceList();
			this.once("gotDeviceList", () => this.emit("ready"));
		});

		this.ws.on('message', this._recvMessage.bind(this));
		this.wsEmitter.on("dynamicMessage", this._processDynamicMessage.bind(this));
	}

	getDevices() {
		let devices = [];
		for (let device in this._devices) {
			devices.push(this._devices[device]);
		}
		return devices;
	}

	getDeviceById(id) {
		return this._devices[id];
	}

	_getDeviceList() {
		this._sendMessage({
			"CommandType": "DeviceList"
		}, (err, data) => {
			let devices = data.Devices;
			for (let deviceID in devices) {
				if (!(devices[deviceID].ID in this._devices)) {
					this._addDevice(devices[deviceID]);
				}
			}
			this.emit("gotDeviceList");
		});
	}

	_processDynamicMessage(message) {
		debug("Got dynamicMessage", message);

		switch(message.CommandType) {
			case "DynamicIndexUpdated":
				this._processDeviceUpdate(message);
				break;
			default:
				debug("Didn't understand message");
		}
	}

	_processDeviceUpdate(message) {
		debug("Got device update msg", message)
		let devices = message.Devices;
		for (let deviceID in devices) {
			let deviceValues = devices[deviceID].DeviceValues;
			let device = this._devices[deviceID];

			for (let index in deviceValues) {
				device.updateProp(index, deviceValues[index].Value);
			}
		}
	}

	_addDevice(devData) {
		debug("Adding device", devData);
		let device = new AlmondDevice(this, devData);

		this._devices[device.id] = device;
		this.emit("deviceAdded", device);
	}

	_sendMessage(json, cb) {
		const mii = randomstring.generate();

		json["MobileInternalIndex"] = mii;

		let msg = JSON.stringify(json);
		this.ws.send(msg);
		debug("Message Sent", msg);

		this.wsEmitter.on(mii, cb.bind(this));
	}

	_recvMessage(message) {
		debug("Message Recved", message);

		const json = JSON.parse(message);
		const mii = json["MobileInternalIndex"];

		if (typeof mii === "undefined") {
			debug("Got dynamic message");
			this.wsEmitter.emit("dynamicMessage", json);
		} else {
			this.wsEmitter.emit(mii, null, json);
		}
	}
}

class AlmondDevice extends EventEmitter {
	constructor(client, config) {
		super();

		this.client = client;

		this.id = Number(config.Data.ID);
		this.name = config.Data.Name;
		this.type = Number(config.Data.Type);
		this.location = config.Data.Location;
		this.manufacturer = config.Data.Manufacturer || "Unknown Manufacturer";
		this.model = config.Data.Model || "Unknown Model";

		this.props = deviceProps[this.type];

		this._deviceValues = {};

		for (let id in config.DeviceValues) {
			this._deviceValues[id] = {
				id: Number(id),
				name: config.DeviceValues[id].Name,
				value: this.parseAlmondValue(config.DeviceValues[id].Value)
			};
		}
	}

	parseAlmondValue(value) { // Convert type, as Almond+ encodes every value as a string
		if (typeof value === 'string') {
			if (value === 'true' || value === 'false') {
				value = value == 'true';
			} else if (value !== '' && Number(value) == value) {
				value = Number(value);
			}
		}
		return value;
	}

	setProp(prop, value, cb) {
		if (value == this._deviceValues[prop].value) {
			if (cb) cb(value);
			return;
		}

		this.client._sendMessage({
			"CommandType": "UpdateDeviceIndex",
			"ID": String(this.id), // Almond+ encodes every value as a string
			"Index": String(prop), // Almond+ encodes every value as a string
			"Value": String(value) // Almond+ encodes every value as a string
		}, (err, message) => {
			if (err) {
				if (cb) return cb(err);
				return err;
			}
			if (message.Success) {
				debug("Successfully sent property [%s] update [%s]", prop, value);
				if (cb) this.prependListener('valueUpdated', (propUpdated, newValue) => {
					if (Number(propUpdated) == prop) {
						this.removeListener('valueUpdated', waitForDevicePropUpdate);
						if (cb) cb(this.parseAlmondValue(newValue));
					}
				});
			}
		});
	}

	getProp(prop) {
		return this._deviceValues[prop].value;
	}

	updateProp(prop, value) {
		prop = Number(prop);
		value = this.parseAlmondValue(value);

		if (typeof this._deviceValues[prop] === "undefined") return;
		if (this._deviceValues[prop].value === value) return;

		debug("Updating value", prop, "from", this._deviceValues[prop].value, "to", value);
		this._deviceValues[prop].value = value;
		this.emit("valueUpdated", prop, value);
	}
}

class WebSocketEmitter extends EventEmitter {
	constructor() {
		super();
	}
}