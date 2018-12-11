import { createInterface, Interface } from 'readline';
import * as commands from './commands.json';
import { PluginAPI } from '../../lib/Client';
import Plugin from '../../lib/Plugin'

type CommandParam = {
    key: string;
    value: string;
}

type Command = {
    description: string;
    params?: CommandParam[]
}

export const VERSION = 1;

export default class CLI extends Plugin {
    commands: object;
    rl: Interface;
    api: PluginAPI;

    constructor(api: PluginAPI) {
        super({});
        this.commands = {};
        this.api = api;
        // this.registerCommand('init', () => {
        //     this.client.init();
        // });
        // this.registerCommand('queueretry', () => {
        //     this.connection.retryCommand();
        // });
        // this.registerCommand('queueskip', () => {
        //     this.connection.skipCommand();
        // });
        // this.registerCommand('queueclear', () => {
        //     this.connection.clearCommandQueue();
        // });
        // this.registerCommand('queuelast', () => {
        //     console.log(this.connection.getCommand().label, this.connection.getCommand().options);
        // });
        // this.registerCommand('pluginlist', () => {
        //     const pluginsList = this.client.getPluginsStatus();
        //     for (let plugin of Object.keys(pluginsList)) {
        //         console.log(plugin + (pluginsList[plugin].loaded ? ` [v${pluginsList[plugin].version}] - Loaded` : " Not loaded"));
        //     }
        // });
        // this.registerCommand('pluginreload', () => {
        //     this.client.reloadPlugins();
        // });
        // this.registerCommand('pluginload', plugin => {
        //     this.client.loadPlugin(plugin);
        // });
        // this.registerCommand('pluginunload', plugin => {
        //     this.client.unloadPlugin(plugin);
        // });

        this.handleAutoCompletion = this.handleAutoCompletion.bind(this);
        this.onLine = this.onLine.bind(this);

        // commandline interface
        this.rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '> ',
            completer: this.handleAutoCompletion
        })
        .on('line', this.onLine);
    }

    handleAutoCompletion(line: string) {
        const words = line.split(" ");
        const completions = this.api.connected()
            ? Object.keys(commands).concat(Object.keys(this.commands))
            : [];
        const hits = completions.filter(c => c.startsWith(words[0]));

        if (commands && commands[words[0]]) {
            this.autoCompleteCommand(commands[words[0]]);
        }

        // show all completions if none found
        return [hits.length ? hits : completions, words[0]];
    }

    autoCompleteCommand(cmd: Command) {
        process.stdout.write(`\nDescription: ${cmd.description}\n`);
        if (cmd.params) {
            process.stdout.write(`Params:\n`);
            for (let param of cmd.params) {
                process.stdout.write(`\t${param.key} = ${param.value}`);
            }
            process.stdout.write("\n");
        }
    }

    async onLine(line: string) {
        const [cmd, ...args] = line.trim().split(" ");
        if (!this.api.connected()) {
            const status = this.api.connecting() ? "Connecting" : "Disconnected";
            console.log(`Status: ${status}`);
        } else {
            if (this.isCommand(cmd)) {
                await this.executeCommand(cmd, args);
            } else if (cmd === 'help') {
                this.handleHelpCommand(args)
            } else {
                this.sendCommand(cmd, args);
            }
        }
        this.rl.prompt();
    }

    showHelp(cmd?: string) {
        return this.api.send('help', [cmd]);
    }

    async handleHelpCommand(args: string[]) {
        if (args.length === 1) {
            await this.showHelp(args[0]);
        } else {
            await this.showHelp();
        }
    }

    async sendCommand(cmd: string, args?: string[]) {
        try {
            const param = await this.api.send(cmd, args);
            console.log("Result:", param);
        } catch(err) {
            console.warn("Error: ", err);
        }
    }

    registerCommand(cmd: string, callback: Function) {
        if (!this.isCommand(cmd)) {
            this.commands[cmd] = callback;
        }
    }
    isCommand(cmd: string) {
        return this.commands[cmd] !== undefined;
    }

    executeCommand(cmd: string, args: any) {
        if (this.isCommand(cmd)) {
            return this.commands[cmd](...args);
        }
        return false;
    }
}
