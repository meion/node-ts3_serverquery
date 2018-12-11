import * as fs from 'fs';
import Log from './Log';
import { PluginAPI } from './Client';

// Broadcasted events from client
// connected() {}
// disconnected(hadError) {}
// init() {}
// reload() {}
// unload() {}
export default class Plugin {
    config: any;
    api: PluginAPI;

    constructor(defaultConfig: any) {
        this.config = defaultConfig;
    }
    load(api: PluginAPI) {
        this.api = api;
    }

    /**
     * @param configFile Absolute path to config file
     */
    async loadConfig(configFile: string) {
        const url = new URL("file://");
        url.pathname = configFile;
        if (fs.existsSync(url)) {
            try {
                const newConfig = await import(configFile);
                if (newConfig) {
                    this.config = {
                        ...this.config,
                        ...newConfig
                    };
                }
            } catch (err) {
                Log(`Error reading config: ${err}`, this.constructor.name, 1);
            }
        } else {
            Log("Config not found", this.constructor.name, 2);
        }
    }
}
