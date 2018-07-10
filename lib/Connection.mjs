import { createConnection } from 'net';
import DataStore from './Connection/DataStore';
import CommandQueue from './Connection/CommandQueue';
import VALID_EVENTS from './Connection/valid_events.json';
import VALID_HOOKS from './Connection/valid_hooks.json';

// constants
const STATE = {
    CLOSED: 0,
    READY: 1,
    AWAITING_DATA: 2,
    PROCESSING_DATA: 3,
    INIT: 4
};
const SHOULD_PARSE_PARAMS = {
    error: 1,
    serverinfo: 1,
    serverlist: 2,
    clientinfo: 1,
    clientlist: 2,
    channelinfo: 1,
    channellist: 2,
    logview: 2,
};
const REGISTERED_EVENTS = {};

function parseParams(msg, type, start = 0) {
    if (type === 2) {
        return msg.split(/\|/g).map(item => parseParams(item, 1));
    }
    if (type !== 0) {
        const params = {};
        for (let param of msg.substr(start).trim().split(" ").map(param => param.split("="))) {
            params[param[0]] = param[1];
        }
        return params;
    }
    return false;
}

export default class Connection {
    constructor(config) {
        this.state = STATE.CLOSED;
        this.registeredHooks = {};

        this.store = new DataStore(this);
        this.commandQueue = new CommandQueue(this);

        this.buffer = "";

        this.pingTimer;

        this.connection = new createConnection({
            port: config.auth.port,
            host: config.auth.host
        }, () => {
            // Send "ping" every 5 minute
            this.pingTimer = setInterval(() => {
                this.send('version', undefined, {noOutput: true}, 0);
            }, 300000);
            this.state = STATE.INIT;
            this.registerHook('error', {
                error: (params) => {
                    // DEBUG
                    if (params.id !== '0') {
                        console.log("Error check failed: ", params);
                        this.getCommand().failed = true;
                        if (this.getCommand().options.mustReturnOK) {
                            this.getCommand().reject(params);
                        }
                    }
                }
            });
        });
    }

    connected() {
        return this.state !== STATE.CLOSED;
    }

    ready() {
        return this.state === STATE.READY;
    }

    init() {
        this.connection.on('data', data => {
            const msg = data.toString('utf8');

            if (this.state === STATE.INIT) {
                // TeamSpeak always sends a "welcome" packet on established connection
                this.state = STATE.READY;
            } else {
                this.state = STATE.PROCESSING_DATA;
                const lines = msg.split(/\n\r/g);

                // Find event packet, should be the last packet/line in a message from the server
                const errorPacket = lines.filter(line => {
                    const event = line.substr(0, line.indexOf(" "));
                    return this.registeredHooks[event] !== undefined
                }).length;

                if (errorPacket) {
                    this.recievedData(this.buffer + msg);
                    this.buffer = "";
                } else {
                    this.buffer += msg;
                }
            }
            if (this.ready()) {
                this.commandQueue.processQueue();
            }
        }).on('close', hadError => {
            this.state = STATE.CLOSED;
            if (hadError) {
                console.error("Error!");
            } else {
                console.info("Connection closed.");
            }
            clearInterval(this.pingTimer);
        });
    }

    recievedData(msg) {
        if (this.getCommand().label === 'help') {
            process.stdout.write(msg);
            this.state = STATE.READY;
        } else {
            for (let line of msg.split(/\n/)) {
                line = line.trim();
                if (!line) {
                    continue;
                }
                const event = line.substr(0, line.indexOf(" "));

                const params = this.registeredHooks[event]
                    ? parseParams(line, 1, event.length + 1)
                    : parseParams(line, SHOULD_PARSE_PARAMS[this.getCommand().label]);

                if (VALID_HOOKS[event]) {
                    this.recievedEvent(params, event, line);
                }
                if (!this.getCommand().options.expectData || event !== "error") {
                    if (!this.getCommand().failed || !this.getCommand().options.mustReturnOK) {
                        this.getCommand().resolve(params, event, line);
                    }
                }
            }
        }
    }

    recievedEvent(params, event, msg) {
        if (this.registeredHooks[event]) {
            for (let pluginHooks of Object.values(this.registeredHooks[event])) {
                for (let callback of pluginHooks) {
                    callback(params, msg);
                }
            }
        }
        this.state = STATE.READY;
    }

    retryCommand() {
        this.processQueueItem(this.getCommand());
    }

    skipCommand() {
        if (this.getCommand().failed) {
            this.getCommand() = {};
            this.processQueue();
        }
    }

    clearCommandQueue() {
        this.commandQueue.clearQueue(0);
    }

    getCommandQueue() {
        return this.commandQueue;
    }

    getCommand() {
        return this.commandQueue.getCommand();
    }

    writeRaw(str) {
        this.state = STATE.AWAITING_DATA;
        // DEBUG
        if (!this.getCommand().options.noOutput) {
            console.log("WRITE: " + str.replace("\r\n", "\\r\\n"));
        }
        this.connection.write(Buffer.from(str, 'utf8'));
    }

    writeToConnection(str) {
        this.writeRaw(str + "\r\n");
    }

    send(cmd, args, options, priority = 0) {
        if (!cmd) {
            return;
        }
        let str;
        if (typeof args === 'object') {
            if (Array.isArray(args)) {
                str = `${cmd} ${args.join(" ")}`;
            } else {
                const params = Object.entries(args).map(([key, value]) => `${key}=${value}`).join(" ");
                str = `${cmd} ${params}`;
            }
        } else if (typeof args === 'string') {
            str = `${cmd} ${args}`;
        } else {
            str = cmd;
        }
        return new Promise((resolve, reject) => {
            this.commandQueue.add(cmd, options, priority, () => {
                this.writeToConnection(str);
            }, resolve, reject);
        });
    }

    registerHook(event, callbacks, id = "connection") {
        for (let hook of Object.keys(callbacks)) {
            if (VALID_EVENTS[event][hook]) {
                if (this.registeredHooks[hook] === undefined) {
                    this.registeredHooks[hook] = {};
                }
                if (this.registeredHooks[hook][id] === undefined) {
                    this.registeredHooks[hook][id] = [];
                }
                this.registeredHooks[hook][id].push(callbacks[hook]);
            } else {
                console.error(`Invalid hook: ${hook}, event: ${event}`);
                return false;
            }
        }
        return true;
    }

    registerEvent(event, options, callbacks, id) {
        if (VALID_EVENTS[event]) {
            let validHooks = this.registerHook(event, callbacks, id);
            if (validHooks) {
                let args = [`event=${event}`];
                if (typeof options === 'object') {
                    args.push(Object.entries(options).map(option => `${option[0]}=${option[1]}`));
                    if (options.id) {
                        event += options.id;
                    }
                }
                if (!REGISTERED_EVENTS[event]) {
                    REGISTERED_EVENTS[event] = true;
                    this.send('servernotifyregister', args);
                }
            }
        }
    }

    unregisterHook(event, hook, id) {
        if (
            VALID_EVENTS[event][hook] &&
            this.registeredHooks[hook] &&
            this.registeredHooks[hook][id]
        ) {
            delete this.registeredHooks[hook][id];
            if (Object.keys(this.registeredHooks[hook]).length === 0) {
                delete this.registeredHooks[hook];
            }
        }
    }
    unregisterEvent(event, hooks, id) {
        if (VALID_EVENTS[event]) {
            for (let hook of hooks) {
                this.unregisterHook(event, hook, id);
            }
        }
    }
}
