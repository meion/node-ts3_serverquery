/// <reference path="Types/Config.d.ts" />
/// <reference path="Types/Types.d.ts" />
/// <reference path="Types/Command.d.ts" />
/// <reference path="Types/Events.d.ts" />
import {
    createConnection, Socket
} from "net";
import chalk from "chalk";
import DataStore from "./Connection/DataStore";
import CommandQueue from "./Connection/CommandQueue";
import VALID_EVENTS from "./Connection/valid_events";
import VALID_HOOKS from "./Connection/valid_hooks";
import {
    parseArgsToString,
    parseParams
} from "./Connection/Utils";
import Log from "./Log";

// constants
enum STATE {
    CLOSED = 0,
    READY = 1,
    AWAITING_DATA = 2,
    PROCESSING_DATA = 3,
    INIT = 4
};

/*
1: Single item response
2: Array/list response, items seperated by "|"
*/
enum SHOULD_PARSE_PARAMS {
    error = 1,
    serverinfo = 1,
    serverlist = 2,
    clientinfo = 1,
    clientlist = 2,
    channelinfo = 1,
    channellist = 2,
    logview = 2,
};

export default class Connection {
    state: STATE;
    registeredHooks: { [event: string]: {} };
    REGISTERED_EVENTS: object;
    store: DataStore;
    commandQueue: CommandQueue;
    commandResult: boolean | object;
    buffer: string;
    pingTimer: null | NodeJS.Timeout;
    connection: Socket;

    constructor(config: BotConfig) {
        this.state = STATE.CLOSED;
        this.registeredHooks = {};
        this.REGISTERED_EVENTS = {};

        this.store = new DataStore(this);
        this.commandQueue = new CommandQueue(this);
        this.commandResult = {};

        this.buffer = "";

        this.pingTimer = null;

        this.onError = this.onError.bind(this);
        this.onLookup = this.onLookup.bind(this);
        this.onTimeout = this.onTimeout.bind(this);
        this.onData = this.onData.bind(this);
        this.onClose = this.onClose.bind(this);

        this.heartbeat = this.heartbeat.bind(this);
        this.connectionCallback = this.connectionCallback.bind(this);
        this.errorHook = this.errorHook.bind(this);

        this.registerEvent = this.registerEvent.bind(this);
        this.unregisterEvent = this.unregisterEvent.bind(this);

        this.send = this.send.bind(this);
        this.connected = this.connected.bind(this);
        this.connecting = this.connecting.bind(this);

        this.connection = this.init(config);
    }

    connected() : boolean {
        return this.state !== STATE.CLOSED;
    }
    connecting() : boolean {
        return this.connection.connecting;
    }
    ready() : boolean {
        return this.state === STATE.READY;
    }

    init(config: BotConfig) : Socket {
        Log(`Connecting to ${config.auth.host}:${config.auth.port}`, this.constructor.name, 3);
        return createConnection({
                port: config.auth.port,
                host: config.auth.host
            }, this.connectionCallback)
            .on('error', this.onError)
            .on('lookup', this.onLookup)
            .on('timeout', this.onTimeout)
            .on('data', this.onData)
            .on('close', this.onClose);
    }
    connectionCallback() {
        Log("Connected!", this.constructor.name);
        // Send "ping" every minute
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(this.heartbeat, 60000);
        this.state = STATE.INIT;
        this.registerHook('error', {
            error: this.errorHook
        });
    }

    async heartbeat() {
        Log("Sending heartbeat...", this.constructor.name, 4);
        const startTime = process.hrtime();
        await this.send('version', undefined, {
            noOutput: true
        }, 0);
        const diff = process.hrtime(startTime);
        const ping = diff[0] > 0 ? diff[0] / 1e6 : 0 + diff[1] / 1e6;
        Log(`Ping: ${ping}ms`, this.constructor.name, 5);
    }

    errorHook(params: TS_ErrorState) {
        if (params.id !== '0') {
            Log(`Command failed: ${chalk.yellow(this.commandQueue.getCommand().commandStr)} ${JSON.stringify(this.commandQueue.getCommand())}, ${JSON.stringify(params)}`, this.constructor.name, 2);
            this.getCommand().failed = true;
            this.getCommand().reject(params);
        } else {
            this.getCommand().resolve(this.commandResult || {
                result: "OK"
            });
        }
    }

    onError(e: Error) {
        Log(`ERROR: ${e}`, this.constructor.name, 1);
    }

    onLookup() {
        Log(`event:lookup ${JSON.stringify(arguments)}`, this.constructor.name, 5);
    }

    onTimeout() {
        Log(`event:timeout ${JSON.stringify(arguments)}`, this.constructor.name, 5);
    }

    onClose(hadError: boolean) {
        this.state = STATE.CLOSED;
        Log("Closing connection...", this.constructor.name, hadError ? 1 : 3);
        clearInterval(this.pingTimer);
    }
    onData(data: Buffer) {
        const msg = data.toString('utf8');

        if (this.state === STATE.INIT) {
            // TeamSpeak always sends a "welcome" packet on established connection
            this.state = STATE.READY;
        } else {
            this.processData(msg);
        }
        if (this.ready()) {
            this.commandQueue.processQueue();
        }
    }
    processData(msg: string) {
        this.state = STATE.PROCESSING_DATA;

        // Weird stuff happened, making sure this is the last "packet" for this event/msg
        const lastPacket = msg.substr(msg.length - 2) === "\n\r";

        if (lastPacket) {
            this.recievedData(this.buffer + msg);
            this.buffer = "";
        } else {
            this.buffer += msg;
        }
    }

    recievedData(msg: string) {
        if (this.getCommand().label === 'help') {
            process.stdout.write(msg);
        } else {
            Log(`Recieved data: ${msg}`, this.constructor.name, 5);
            this.parseRecievedData(msg);
        }
        this.state = STATE.READY;
    }

    parseRecievedData(msg: string) {
        for (let line of msg.split("\n\r")) {
            line = line.trim();
            if (!line) {
                continue;
            }
            const event = line.substr(0, line.indexOf(" "));
            this.handleRecievedLine(line, event);
        }
    }

    handleRecievedLine(line: string, event: string) {
        const params = VALID_HOOKS[event] ?
            parseParams(line, 1, event.length + 1) :
            parseParams(line, SHOULD_PARSE_PARAMS[this.getCommand().label]);

        if (VALID_HOOKS[event]) {
            this.recievedEvent(params, event, line);
        } else {
            this.commandResult = params;
        }
    }

    recievedEvent(params: any, event: string, msg: string) {
        if (this.registeredHooks[event]) {
            for (let pluginHooks of Object.values(this.registeredHooks[event])) {
                for (let callback of Object.values(pluginHooks)) {
                    callback(params, msg);
                }
            }
        }
    }

    retryCommand() {
        const command = this.getCommand();

        this.commandQueue.add(command, 0);
    }

    skipCommand() {
        if (this.getCommand().failed) {
            this.commandQueue.processQueue();
        } else {
            this.getCommand().reject('skipped');
            this.state = STATE.READY;
            this.commandQueue.processQueue();
        }
    }

    clearCommandQueue() {
        this.commandQueue.clearQueue(0);
    }

    getCommandQueue(): CommandQueue {
        return this.commandQueue;
    }

    getCommand(): Command {
        return this.commandQueue.getCommand();
    }

    writeRaw(data: string) {
        this.commandResult = false;
        this.state = STATE.AWAITING_DATA;
        // TODO: change how we log this, should be opt-in if we should log to level 3
        let logLevel = this.getCommand().options.noOutput ? 5 : 4;
        Log(`writeRaw(): ${data.replace("\r\n", "\\r\\n")}`, this.constructor.name, logLevel);
        this.connection.write(Buffer.from(data, 'utf8'));
    }

    writeToConnection(data: string) {
        this.writeRaw(data + "\r\n");
    }

    /**
     * @param cmd Name of the command to be sent to teamspeak server
     * @param args DO NOT USE A STRING, use a JSON structure
     * @param options Options..
     * @param priority 0=highest, 2=lowest
     */
    send(cmd: string, args?: object | string[], options: CommandOptions = {}, priority: number = 0) {
        if (!cmd) {
            return;
        }
        return new Promise((resolve, reject) => {
            let commandStr = parseArgsToString(cmd, args);
            const command: Command = {
                label: cmd,
                command: () => {
                    this.writeToConnection(commandStr);
                },
                commandStr,
                options,
                resolve,
                reject
            };
            this.commandQueue.add(command, priority);
        });
    }

    registerHook(event: string, callbacks: {[hook: string]: Function}, id: string = "connection") {
        for (let hook of Object.keys(callbacks)) {
            if (VALID_EVENTS[event][hook]) {
                this._pushHook(hook, id, callbacks[hook]);
            } else {
                Log(`Invalid hook: ${hook}, event: ${event}`, this.constructor.name, 2);
                return false;
            }
        }
        return true;
    }
    _pushHook(hook: string, id: string, callback: Function) {
        if (this.registeredHooks[hook] === undefined) {
            this.registeredHooks[hook] = {};
        }
        if (this.registeredHooks[hook][id] === undefined) {
            this.registeredHooks[hook][id] = [];
        }
        this.registeredHooks[hook][id].push(callback);
    }

    registerEvent(event: string, options: object, callbacks: {[hook: string]: Function}, id: string) {
        if (VALID_EVENTS[event]) {
            if (this.registerHook(event, callbacks, id)) {
                if (!this.REGISTERED_EVENTS[event]) {
                    this.REGISTERED_EVENTS[event] = true;
                    this.send('servernotifyregister', {
                        event,
                        ...options
                    });
                }
            }
        }
    }

    unregisterHook(event: string, hook: string, id: string) {
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
    unregisterEvent(event: string, hooks: string[], id: string) {
        if (VALID_EVENTS[event]) {
            for (let hook of hooks) {
                this.unregisterHook(event, hook, id);
            }
        }
    }
}
