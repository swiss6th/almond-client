Almond+ WebSocket client for [swiss6th/homebridge-almond](https://github.com/swiss6th/homebridge-almond).

# Features
- Keepalive in case connection to Almond+ is lost
- Resending of messages after timeout
- Type conversion of JSON to and from Almond+ (Almond+ uses only strings)
- Customizable update frequency for each device property

# Device Personalities
Device personalities are read from <devicePersonalities.json>. This file maps device type identifiers (numbers) to their corresponding friendly names (strings), and it does the same for each device's properties.

# Update Frequency
In <devicePersonalities.json>, you can specify one of three different `"UpdateFrequency"` options for each device property:

- `"onChange"`: An update to the property will be emitted whenever the value changes (it no longer matches the cached value). This option is suitable for most devices and properties, generating the smallest amount of update "chatter."
- `"onTrigger"`: An update to the property will be emitted whenever the device sends a value, even if the value is the same as the cached value. This option is useful for devices like programmable buttons, where values are used as triggers for other actions.
- `"always"`: An update to the property will be emitted whenever the device sends a value, as well as anytime the cached values are updated by the client (e.g., after recovering from a connection loss). This option is useful for devices like smoke detectors, where repeated values indicate the continued presence of a condition.

**Warning**: The choices of update frequencies listed in <devicePersonalities.json> are my own and may not suit your needs. Change them as you see fit. Under no circumstances will I be held liable if you missed a crucial value update!