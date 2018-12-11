/// <reference path="Types/Config.d.ts" />
/// <reference path="Types/Types.d.ts" />
import * as path from "path";
import * as fs from "fs";
import chalk from "chalk";
import Log from "./Log";
import Connection from "./Connection";
import Plugin from "./Plugin";

const pluginsPath = path.resolve('./plugins');

type PluginObject = {
    plugin: Plugin;
    loaded?: boolean;
    version?: string | number;
};

export interface PluginAPI {
    getSelf(): TS_whoami;
    send(cmd: string, args?: object | string[], options?: CommandOptions, priority?: number): Promise<any>;

    connected(): boolean;
    connecting(): boolean;

    fetchList(list: string, noCache?: boolean): Promise<any[]>;
    fetchInfo(list: string, keyName: string, keyValue: string | number, noCache?: boolean): Promise<any>;
    forceListUpdate(list: string, key: string, id: string | number, args: object): void;
    forceInfoUpdate(list: string, id: string | number, args: object): void;

    registerEvent(event: string, options: object, callbacks: {[hook: string]: Function}, id: string): void;
    unregisterEvent(event: string, hooks: string[], id: string): void;
};

export default class Client {
    connection: Connection;
    plugins: {[pluginName: string]: PluginObject};
    config: BotConfig;
    commands: object;
    inited: boolean;
    me: TS_whoami;
    pluginAPI: PluginAPI;

    constructor(connection: Connection, config: BotConfig) {
        this.connection = connection;
        this.connection.connection.on('connect', () => {
            this.broadcast('connected');
        }).on('close', hadError => {
            this.broadcast('disconnected', hadError);
        });

        this.plugins = {};
        this.config = config;
        this.commands = {};
        this.inited = false;

        this.getSelf = this.getSelf.bind(this);

        this.pluginAPI = {
            getSelf: this.getSelf,
            send: this.connection.send,
            connected: this.connection.connected,
            connecting: this.connection.connecting,
            fetchInfo: this.connection.store.fetchInfo,
            fetchList: this.connection.store.fetchList,
            forceInfoUpdate: this.connection.store.forceInfoUpdate,
            forceListUpdate: this.connection.store.forceListUpdate,
            registerEvent: this.connection.registerEvent,
            unregisterEvent: this.connection.unregisterEvent
        };

        this.reloadPlugins();
    }
    getSelf() {
        return this.me;
    }
    // Handle plugins
    broadcast(event: string, params?: any) {
        for (let plugin of Object.values(this.plugins).filter(plugin => plugin.loaded)) {
            this.notify(plugin, event, params);
        }
    }
    notify(plugin: PluginObject, event: string, params?: any) {
        return new Promise( (resolve, reject) => {
            let result = true;
            if (typeof plugin.plugin[event] === "function") {
                const pluginResponse = plugin.plugin[event](params);
                if (pluginResponse !== undefined) {
                    result = pluginResponse;
                }
            }
            if (result) {
                resolve();
            } else {
                reject(result);
            }
        })
    }
    getPluginsStatus() {
        const plugins = {};
        for (let plugin of Object.keys(this.plugins)) {
            plugins[plugin] = {
                loaded: this.plugins[plugin].loaded
            };
            if (this.plugins[plugin]) {
                plugins[plugin].version = this.plugins[plugin].version
            }
        }
        return plugins;
    }
    reloadPlugins() {
        for (let pluginName of Object.keys(this.config.plugins)) {
            if (this.config.plugins[pluginName] || (this.plugins[pluginName] && this.plugins[pluginName].loaded)) {
                this.loadPlugin(pluginName);
            } else {
                delete this.plugins[pluginName];
            }
        }
    }
    loadPlugin(pluginName: string) {
        if (!this.plugins[pluginName] || !this.plugins[pluginName].plugin) {
            const pluginPath = path.join(pluginsPath, pluginName);
            fs.promises.access(pluginPath).then(() => {
                this.initPlugin(pluginName);
            }).catch(() => {
                Log(`Plugin ${pluginName} not found!`, this.constructor.name, 1);
            });
        } else {
            this.notify(this.plugins[pluginName], 'reload').then(() => {
                Log(`Plugin ${pluginName} reloaded!`, this.constructor.name, 4);
            }).catch(err => {
                Log(`Error reloading plugin ${pluginName}: ${err}`, this.constructor.name, 1);
            });
        }
    }
    initPlugin(pluginName: string) {
        import(path.resolve(pluginsPath, pluginName)).then(plugin => {
            this.plugins[pluginName] = {
                plugin: new plugin.default(),
                version: plugin.VERSION,
                loaded: true
            };
            // this.plugins[pluginName].plugin.load(this.connection, this);
            this.plugins[pluginName].plugin.load(this.pluginAPI);
            this.config.plugins[pluginName] = true;
            if (this.connection.connected()) {
                this.notify(this.plugins[pluginName], 'connected', this.connection).then(() => {
                    if (this.inited) {
                        this.notify(this.plugins[pluginName], 'init');
                    }
                });
            }
            Log(`Plugin ${chalk.green(pluginName)} [${this.plugins[pluginName].version}] loaded`, this.constructor.name);
        }).catch(err => {
            Log(`Error loading plugin ${pluginName}: ${err}`, this.constructor.name, 1);
        });
    }
    unloadPlugin(pluginName) {
        if (this.plugins[pluginName]) {
            this.notify(this.plugins[pluginName], 'unload').then(() => {
                delete this.plugins[pluginName];
            });
        } else {
            Log(`Plugin ${pluginName} not loaded`, this.constructor.name, 1);
        }
    }
    // /Handle plugins
    createPluginHook(pluginName, hook, callback) {

    }
    createPluginEvent(pluginName, event, callback) {

    }
    registerPluginHook() {

    }
    registerPluginEvent() {

    }

    login(username: string, password: string) {
        return this.connection.send('login', { client_login_name: username, client_login_password: password }, {
            noOutput: true
        });
    }

    init() {
        if (this.connection.connected()) {
            Log("Initializing...", this.constructor.name, 3);
            Promise.all([
                this.login(this.config.auth.username, this.config.auth.password),
                this.connection.send('use', [this.config.defaultServer], {
                    noOutput: true
                }),
                this.connection.send('clientupdate', { client_nickname: this.config.nickname }, {
                    noOutput: true
                })
            ])
            .then(() => this.connection.send("whoami"))
            .then( (me:TS_whoami) => {
                this.me = me;
                this.inited = true;
                this.broadcast('init');
            })
            .catch(err => {
                Log(`Error in init: ${typeof err === "object" ? JSON.stringify(err) : err}`, this.constructor.name, 1);
            });
        } else {
            Log("Not connected", this.constructor.name, 2);
        }
    }
}
