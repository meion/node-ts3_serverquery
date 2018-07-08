import fs from 'fs';

export default class Plugin {
    constructor(defaultConfig) {
        this.config = defaultConfig;
        this.connection = false;
    }
    connected(connection) {
        this.connection = connection;
    }
    loadConfig(configFile) {
        configFile = configFile.replace("file://", "");
        return fs.promises.access(configFile).then(() => {
            return import(configFile).then(newConfig => {
                if (newConfig.default) {
                    this.config = {
                        ...this.config,
                        ...newConfig.default
                    };
                }
            }).catch(err => {
                console.error("Error reading config: ", err);
            });
        }).catch(() => {
            console.log("Config not found");
        });
    }
}
