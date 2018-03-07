"use strict";

var util = require('util');
var WebSocket = require('ws');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('almond-client');
var randomstring = require("randomstring");
var deviceProps = require("./deviceProperties.js");	

function WebSocketClient(){
	this.number = 0;	// Message number
	this.autoReconnectInterval = 5*1000;	// ms
}
WebSocketClient.prototype.open = function(url){
	this.url = url;
	this.instance = new WebSocket(this.url);
	this.instance.on('open',()=>{
		this.onopen();
	});
	this.instance.on('message',(data,flags)=>{
		this.number ++;
		this.onmessage(data,flags,this.number);
	});
	this.instance.on('close',(e)=>{
		switch (e){
		case 1000:	// CLOSE_NORMAL
			console.log("WebSocket: closed");
			break;
		default:	// Abnormal closure
			this.reconnect(e);
			break;
		}
		this.onclose(e);
	});
	this.instance.on('error',(e)=>{
		switch (e.code){
		case 'ECONNREFUSED':
			this.reconnect(e);
			break;
		default:
			this.onerror(e);
			break;
		}
	});
}
WebSocketClient.prototype.send = function(data,option){
	try{
		this.instance.send(data,option);
	}catch (e){
		this.instance.emit('error',e);
	}
}
WebSocketClient.prototype.reconnect = function(e){
	console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`,e);
	var that = this;
	setTimeout(function(){
		console.log("WebSocketClient: reconnecting...");
		that.open(that.url);
	},this.autoReconnectInterval);
}
WebSocketClient.prototype.onopen = function(e){	console.log("WebSocketClient: open",arguments);	}
WebSocketClient.prototype.onmessage = function(data,flags,number){	console.log("WebSocketClient: message",arguments);	}
WebSocketClient.prototype.onerror = function(e){	console.log("WebSocketClient: error",arguments);	}
WebSocketClient.prototype.onclose = function(e){	console.log("WebSocketClient: closed",arguments);	}

var AlmondClient = module.exports = function(config) {
    EventEmitter.call(this);
    this.host = config.host;
    this.port = config.port;

    this.username = config.username;
    this.password = config.password;

    var url = util.format("ws://%s:%s/%s/%s", this.host, this.port, this.username, this.password)
    this.ws = new WebSocket(url);
    this.wsEmitter = new WebSocketEmitter();

    this._devices = {};

    var self = this;
    this.ws.on('open', function open() {
        self._getGeviceList();
        self.once("gotDeviceList", function() {
            self.emit("ready");
        });
    });

    this.ws.on('message', this._recvMessage.bind(this));
    this.wsEmitter.on("dynamicMessage", this._processDynamicMessage.bind(this));
}

util.inherits(AlmondClient, EventEmitter);

AlmondClient.DEVICE_TYPE = require("./deviceTypes.js")

AlmondClient.prototype.getDevices = function() {
    var devices = [];
    for (var device in this._devices) {
        devices.push(this._devices[device]);
    }
    return devices;
}

AlmondClient.prototype.getDeviceById = function(id) {
    return this._devices[id];
}

AlmondClient.prototype._getGeviceList = function() {
    var self = this;
    this._sendMessage({
        "CommandType":"DeviceList"
    }, function(err, data) {

        var devices = data.Devices;
        for (var deviceID in devices) {
            if (!(devices[deviceID].ID in self._devices)) {
                self._addDevice(devices[deviceID]);
            }
        }

        self.emit("gotDeviceList")
    });
}

AlmondClient.prototype._processDynamicMessage = function(message) {
    debug("Got dynamicMessage", message);

    switch(message.CommandType) {
        case "DynamicIndexUpdated":
            this._processDeviceUpdate(message);
            break;
        default:
            debug("Didn't understand message");
    }
}

AlmondClient.prototype._processDeviceUpdate = function(message) {
    debug("Got device update msg", message)
    var devices = message.Devices;
    for (var deviceID in devices) {
        var deviceValues = devices[deviceID].DeviceValues;
        var device = this._devices[deviceID];

        for (var index in deviceValues) {
            device.updateProp(index, deviceValues[index].Value);
        }
    }
}

AlmondClient.prototype._addDevice = function(devData) {
    debug("Adding device", devData);
    var device = new AlmondDevice(this, devData);

    this._devices[device.id] = device;
    this.emit("deviceAdded", device);
}

AlmondClient.prototype._sendMessage = function(json, cb) {
    var mii = randomstring.generate();

    json["MobileInternalIndex"] = mii;

    var msg = JSON.stringify(json);
    this.ws.send(msg);
    debug("Message Sent", msg);

    this.wsEmitter.on(mii, cb.bind(this));
}

AlmondClient.prototype._recvMessage = function(message) {
    debug("Message Recved", message);

    var json = JSON.parse(message);
    var mii = json["MobileInternalIndex"];

    if (typeof mii === "undefined") {
        debug("Got dynamic message");
        this.wsEmitter.emit("dynamicMessage", json);
    } else {
        this.wsEmitter.emit(mii, null, json);
    }
}

var AlmondDevice = function(client, config) {
    EventEmitter.call(this);
    this.client = client;

    this.id = config.Data.ID;
    this.name = config.Data.Name;
    this.type = config.Data.Type;
    this.location = config.Data.location;
    this.manufacturer = config.Data.Manufacturer || "Unknown Manufacturer";
    this.model = config.Data.Model || "Unknown Model";

    this.props = deviceProps[this.type];

    this._deviceValues = {};

    for (var id in config.DeviceValues) {
        this._deviceValues[id] = {
            id: id,
            name: config.DeviceValues[id].Name,
            value: config.DeviceValues[id].Value
        };
    }
}

AlmondDevice.prototype.setProp = function(prop, value, cb) {
    var self = this;

    if (value == this._deviceValues[prop].value) {
        cb(value);
        return;
    }
    //this._deviceValues[prop].value = value;

    this.client._sendMessage({
        "CommandType":"UpdateDeviceIndex",
        "ID": this.id,
        "Index": prop,
        "Value": value
    }, function(err, message) {
        if (err) return cb(err);
        if (message.Success) {
            debug("Successfully sent property [%s] update [%s]", prop, value)
	    

            var waitForDevicePropUpdate = function(propUpdated, newValue) {
                if (propUpdated == prop) {
                    self.removeListener('valueUpdated', waitForDevicePropUpdate);
                    //self._deviceValues[prop].value = newValue;

		  // if (typeof newValue === 'string') {
		//		if (newValue === 'true' || newValue === 'false'){

	//			if(typeof this._deviceValues[prop] !== "undefined" && his._deviceValues[prop].value !== newValue)
	//				this._deviceValues[prop].value= newValue == 'true';
	//			}
//			}
//			else{
//				this._deviceValues[prop].value= newValue;
//			}
			cb(newValue);
		    
                }
            }
            if (cb) {
                self.prependListener('valueUpdated', waitForDevicePropUpdate);
		
            }
        }
    });
}

AlmondDevice.prototype.getProp = function(prop) {
    return this._deviceValues[prop].value;
}

AlmondDevice.prototype.updateProp = function(prop, value) {
    // Botch to hide the fact that the almond encodes true/false as strings rather than bools or ints.
    if (typeof value === 'string') {
        if (value === 'true' || value === 'false'){
            value = value == 'true';
        }
    }

    if (typeof this._deviceValues[prop] === "undefined") return;
    if (this._deviceValues[prop].value === value) return;

    debug("Updating value", prop, "from", this._deviceValues[prop].value, "to", value);
    this._deviceValues[prop].value = value;
    this.emit("valueUpdated", prop, value);
}

util.inherits(AlmondDevice, EventEmitter);

var WebSocketEmitter = function() {
    EventEmitter.call(this);
}

util.inherits(WebSocketEmitter, EventEmitter);