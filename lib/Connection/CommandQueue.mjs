import Queue from './Queue';

export default class CommandQueue {
    constructor(connection) {
        this.commandQueue = {
            0: new Queue(),
            1: new Queue(),
            2: new Queue(),
        };
        this.currentCommand = false;
        this.connection = connection;
    }

    clearQueue(id) {
        if (this.commandQueue[id]) {
            this.commandQueue[id].empty();
        }
    }

    processQueue() {
        if (!this.connection.ready()) {
            return;
        }
        for (let queueNr = 0, totalQueues = Object.keys(this.commandQueue).length; queueNr < totalQueues; queueNr++) {
            if (this.commandQueue[queueNr].hasItems()) {
                this.processQueueItem(this.commandQueue[queueNr].shift());
                break;
            }
        }
    }

    processQueueItem(command) {
        if (typeof command === 'object') {
            this.currentCommand = command;
            this.currentCommand.command();
        } else {
            console.warn("Invalid cmd in queue", command);
        }
    }

    add(label, options, priority, command, resolve, reject) {
        if (priority >= 0 & priority < Object.keys(this.commandQueue).length) {
            if (this.commandQueue[priority].length) {
                console.log(`Items in queue(${priority}): ${this.commandQueue[priority].length}`);
            }
            this.commandQueue[priority].add(
                label,
                command,
                resolve,
                reject,
                options
            );
            this.processQueue();
        } else {
            console.warn("Invalid priority:", priority);
        }
    }

    getCommand() {
        return this.currentCommand;
    }
}
