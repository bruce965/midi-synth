// @ts-check

/// <reference types="webmidi"/>

class MIDINote {
	
	/** @returns {number} */
	get pitch() {
		return this._pitch;
	}

	/** @returns {number} */
	get volume() {
		return this._volume;
	}
	set volume(volume) {
		this._volume = volume;
		// TODO: set volume on `this._player` for this note.
	}

	/** @returns {boolean} */
	get active() {
		return true;
	}
	set active(active) {
		if (active) {
			this._channel._midiNoteOn(this._pitch, this._volume);
		}
		else {
			this._channel._midiNoteOff(this._pitch, true);
		}
	}

	/** @param {{ channel: MIDIChannel, pitch: number }} config */
	constructor(config) {
		/** @private @type {MIDIChannel} */
		this._channel = config.channel;

		/** @private @type {number} */
		this._pitch = config.pitch;

		/** @private @type {number} */
		this._volume = 1;
	}
}

class MIDIChannel {

	/** @typedef {{ pitch: number, envelope: any, isDown: boolean }} NoteInfo */

	/** @returns {number} */
	get channel() {
		return this._channel;
	}

	/** @returns {boolean} */
	get sustain() {
		return this._sustain;
	}
	set sustain(sustain) {
		this._sustain = !!sustain;
		if (!this._sustain) {
			for (const note of [...this._activeNotes]) {
				if (!note.isDown)
					this._midiNoteOff(note.pitch, false);
			}
		}
	}

	/** @returns {number} */
	get instrument() {
		return this._instrument.index;
	}
	set instrument(instrument) {
		const info = this._player._player.loader.instrumentInfo(instrument);
		this._instrument = { index: instrument, info };
	}

	/** @param {{ player: WebAudioMIDIPlayer, channel: number }} config */
	constructor(config) {
		/** @private @type {WebAudioMIDIPlayer} */
		this._player = config.player;

		/** @private @type {number} */
		this._channel = config.channel;

		/** @private @type {NoteInfo[]} */
		this._activeNotes = [];

		/** @private @type {{ index: number, info: { title: string, url: string, variable: string } }} */
		this._instrument = { index: 7, info: this._player._player.loader.instrumentInfo(7) };

		this._player._player.loader.decodeAfterLoading(this._player._audioContext, this._instrument.info.variable);
	}

	/**
	 * @param {number} pitch
	 * @returns {MIDINote}
	 */
	getNote(pitch) {
		return new MIDINote({
			channel: this,
			pitch
		});
	}

	/** @private */
	_midiNoteOn(pitch, volume) {
		this._midiNoteOff(pitch, false);

		const envelope = this._player._player.queueWaveTable(this._player._audioContext, this._player._masterChannel.input, window[this._instrument.info.variable], 0, pitch, 999, volume);

		this._activeNotes.push({
			pitch: pitch,
			envelope: envelope,
			isDown: true,
		});
	}

	/** @private */
	_midiNoteOff(pitch, keepIfSustained) {
		for (let i = 0; i < this._activeNotes.length; i++) {
			if (this._activeNotes[i].pitch != pitch)
				continue;

			if (keepIfSustained && this.sustain) {
				this._activeNotes[i].isDown = false;
			}
			else {
				if (this._activeNotes[i].envelope)
					this._activeNotes[i].envelope.cancel();

				this._activeNotes.splice(i, 1);
			}

			break;
		}
	}
}

class WebAudioMIDIPlayer {

	/** @returns {number} */
	get volume() {
		return this._volume;
	}
	set volume(volume) {
		this._volume = +volume;
		this._masterChannel.output.gain.setTargetAtTime(this._volume, 0, 0.0001);
	}

	/** @returns {boolean} */
	get sustain() {
		return this._sustain;
	}
	set sustain(sustain) {
		this._sustain = !!sustain;
		for (const channel in this._channels)
			this._channels[channel].sustain = this._sustain;
	}

	constructor() {
		/** @private @type {AudioContext} */
		this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
		
		/** @private @type {any} */
		this._player = new WebAudioFontPlayer();

		/** @private @type {{ input: AudioDestinationNode, output: GainNode }} */
		this._masterChannel = this._player.createChannel(this._audioContext);
		this._masterChannel.output.connect(this._audioContext.destination);

		/** @private @type {{ [channel: number]: MIDIChannel }} */
		this._channels = {};

		/** @private @type {number} */
		this._volume = 1;

		/** @private @type {boolean} */
		this._sustain = false;
	}

	/**
	 * @param {number} channel
	 * @returns {MIDIChannel}
	 */
	getChannel(channel) {
		if (!this._channels[channel]) {
			this._channels[channel] = new MIDIChannel({
				player: this,
				channel
			});
		}

		return this._channels[channel];
	}
}

// initialize
(async () => {

	const deviceEl = /** @type {HTMLSelectElement} */(document.getElementById('device'));
	const channelEl = /** @type {HTMLSelectElement} */(document.getElementById('channel'));
	const instrumentEl = /** @type {HTMLSelectElement} */(document.getElementById('instrument'));
	const volumeEl = /** @type {HTMLInputElement} */(document.getElementById('volume'));
	const deviceIndicatorEl = document.getElementById('device_indicator');
	const channelIndicatorEl = document.getElementById('channel_indicator');
	const instrumentIndicatorEl = document.getElementById('instrument_indicator');
	const volumeIndicatorEl = document.getElementById('volume_indicator');
	const sustainIndicatorEl = document.getElementById('sustain_indicator');

	if (navigator.requestMIDIAccess) {

		const midiPlayer = new WebAudioMIDIPlayer();
		const player = midiPlayer._player;
		const audioContext = midiPlayer._audioContext;

		try {
			const midi = await navigator.requestMIDIAccess();

			/** @type {string|null} */
			let currentInputDevice = null;

			let lastChannelIndicatorSameChannelEventId = 0;
			let lastChannelIndicatorOtherChannelEventId = 0;
			let chanelIndicatorIsActiveSameChannel = false;

			let ephemeralStorage = {};

			const save = (key, value) => {
				try {
					if (value === undefined)
						localStorage.removeItem(key);
					else
						localStorage.setItem(key, JSON.stringify(value));
				}
				catch (e) {
					if (value === undefined)
						delete ephemeralStorage[key];
					else
						ephemeralStorage[key] = JSON.stringify(value);
				}
			};

			const load = (key, fallback = undefined) => {
				try {
					const value = localStorage.getItem(key);
					if (value == null)
						return fallback;

					return JSON.parse(value);
				}
				catch (e) {
					if (ephemeralStorage[key] == null)
						return fallback;

					return JSON.parse(ephemeralStorage[key]);
				}
			};

			const refreshMidiDevices = () => {

				while (deviceEl.firstChild)
					deviceEl.removeChild(deviceEl.firstChild);

				const option = document.createElement('option');
				option.innerText = "All MIDI devices";
				option.value = '*';

				deviceEl.appendChild(option);

				for (let input of midi.inputs.values()) {
					const option = document.createElement('option');
					option.innerText = input.name;
					option.value = input.id;
					option.selected = currentInputDevice == input.id;

					deviceEl.appendChild(option);
				}
			};

			const setInputDevice = (device) => {
				if (currentInputDevice) {
					if (currentInputDevice == '*') {
						for (let input of midi.inputs.values())
							input.removeEventListener('midimessage', handleMidiMessage);
					}
					else {
						const currentDevice = midi.inputs.get(currentInputDevice);
						if (currentDevice) {
							currentDevice.removeEventListener('midimessage', handleMidiMessage);
						}
					}

					currentInputDevice = null;
				}
				
				currentInputDevice = device;

				if (currentInputDevice == '*') {
					for (let input of midi.inputs.values())
						input.addEventListener('midimessage', handleMidiMessage);
				}
				else {
					const currentDevice = midi.inputs.get(currentInputDevice);
					if (currentDevice) {
						currentDevice.addEventListener('midimessage', handleMidiMessage);
					}
					else {
						console.warn("Invalid device", currentInputDevice);
						setInputDevice('*');
					}
				}

				deviceEl.value = device;

				save('device', device);
			};

			const refreshInstruments = () => {

				while (instrumentEl.firstChild)
					instrumentEl.removeChild(instrumentEl.firstChild);

				const instrumentKeys = player.loader.instrumentKeys();
				for (let i = 0; i < instrumentKeys.length; i++) {
					const info = player.loader.instrumentInfo(i);

					const option = document.createElement('option');
					option.innerText = `${i+1}. ${info.title}`;
					option.value = `${i}`;

					instrumentEl.appendChild(option);
				}

				const channelId = +channelEl.value;
				instrumentEl.value = `${midiPlayer.getChannel(channelId).instrument}`;
			};

			const setChannel = (channelId) => {
				const channel = midiPlayer.getChannel(+channelEl.value);
				instrumentEl.value = `${channel.instrument}`;
				sustainIndicatorEl.classList.toggle('indicator-ok', !!channel.sustain);

				channelEl.value = `${channelId}`;

				save(`channel`, channelId);
			};

			const setInstrument = (channelId, instrumentId) => {
				const instrument = player.loader.instrumentInfo(instrumentId);
				const channel = midiPlayer.getChannel(channelId);

				instrumentIndicatorEl.classList.toggle('indicator-ok', false);
				instrumentIndicatorEl.classList.toggle('indicator-warn', true);

				player.loader.startLoad(audioContext, instrument.url, instrument.variable);
				player.loader.waitLoad(() => {
					channel.instrument = instrumentId;

					instrumentIndicatorEl.classList.toggle('indicator-ok', true);
					instrumentIndicatorEl.classList.toggle('indicator-warn', false);
				});

				if (+channelEl.value == channelId)
					instrumentEl.value = `${instrumentId}`;

				save(`instrument_ch${channelId}`, instrumentId)
			};

			const setVolume = (volume) => {
				midiPlayer.volume = volume / 127 * 1.5;
				volumeEl.value = volume;

				volumeIndicatorEl.classList.toggle('indicator-ok', volume > 0);
				volumeIndicatorEl.classList.toggle('indicator-warn', midiPlayer.volume > 1);

				save(`volume`, volume);
			}

			const setSustain = (channel, active) => {
				const midiChannel = midiPlayer.getChannel(channel);
				midiChannel.sustain = active;

				if (+channelEl.value == channel)
					sustainIndicatorEl.classList.toggle('indicator-ok', active);
			};

			const blipChannelIndicator = (sameChannel) => {
				const channelIndicatorEventId = sameChannel ? ++lastChannelIndicatorSameChannelEventId : ++lastChannelIndicatorOtherChannelEventId;
				chanelIndicatorIsActiveSameChannel = chanelIndicatorIsActiveSameChannel || sameChannel;

				channelIndicatorEl.classList.toggle('indicator-ok', true);
				channelIndicatorEl.classList.toggle('indicator-warn', !chanelIndicatorIsActiveSameChannel);

				setTimeout(() => {
					if ((sameChannel ? lastChannelIndicatorSameChannelEventId : lastChannelIndicatorOtherChannelEventId) != channelIndicatorEventId)
						return;

					if (sameChannel)
						chanelIndicatorIsActiveSameChannel = false;

					channelIndicatorEl.classList.toggle('indicator-ok', false);
					channelIndicatorEl.classList.toggle('indicator-warn', false);
				}, 240);
			}

			/** @param {WebMidi.MIDIMessageEvent} event */
			const handleMidiMessage = (event) => {
				const data = event.data;
		
				const cmd = data[0] >> 4;
				const channel = data[0] & 0xf;
				const type = data[0] & 0xf0;
				const pitch = data[1];
				const velocity = data[2];
		
				console.debug('cmd=', cmd, 'channel=', channel, 'type=', type, 'pitch=', pitch, 'velocity=', velocity);
		
				const midiChannel = midiPlayer.getChannel(channel);
				const midiNote = midiChannel.getNote(pitch);

				blipChannelIndicator(+channelEl.value == channel);
		
				switch (type) {
					case 144:
						midiNote.volume = velocity / 100;
						midiNote.active = true;
						break;
					case 128:
						midiNote.active = false;
						break;
					case 176:
						switch (pitch) {
							case 64:
								setSustain(channel, velocity != 0);
								break;
							case 7:
								setVolume(velocity);
								break;
						}
						break;
				}
			};

			deviceEl.addEventListener('change', () => {
				setInputDevice(deviceEl.value);
			});

			channelEl.addEventListener('change', () => {
				setChannel(+channelEl.value);
			});

			instrumentEl.addEventListener('change', () => {
				if (instrumentEl.value != null)
					setInstrument(+channelEl.value, +instrumentEl.value);
			});

			volumeEl.addEventListener('change', () => {
				setVolume(+volumeEl.value);
			});
			
			midi.addEventListener('statechange', refreshMidiDevices);
			refreshMidiDevices();

			refreshInstruments();

			setInputDevice(load(`device`, '*'));
			setVolume(load(`volume`, Math.floor(127 / 1.5)));
			setChannel(load(`channel`, 0));

			for (let channel = 0; channel < 16; channel++)
				setInstrument(channel, load(`instrument_ch${channel}`, 7));

			deviceEl.disabled = false;
			channelEl.disabled = false;
			instrumentEl.disabled = false;
			volumeEl.disabled = false;

			deviceIndicatorEl.classList.toggle('indicator-ok', true);
			deviceIndicatorEl.classList.toggle('indicator-warn', false);
		}
		catch (e) {
			console.error(e);
			deviceIndicatorEl.classList.toggle('indicator-error', true);
			deviceEl.querySelector('option').innerText = "Error";
		}
	}
	else {
		deviceEl.querySelector('option').innerText = "MIDI not supported";
		deviceIndicatorEl.classList.toggle('indicator-error', true);
	}
})();
