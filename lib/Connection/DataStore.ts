import Log from '../Log';
import Connection from '../Connection';

const CACHE_EXPIRE = {
    clientlist: 30000,
    clientinfo: 30000,
    channellist: 30000,
    channelinfo: 30000
};

class Cache {
    data: object;
    expire: number;
    queue: CacheQueueItem[];
    fetching?: boolean;

    length(): number {
        return this.queue.length;
    }
};

type CacheQueueItem = {
    resolve: Function,
    reject: Function
};

export default class DataStore {
    connection: Connection;
    store: {
        [listName: string]: {
            [cacheId: string] : Cache
        }
    };
    storeList: {
        [cacheId: string] : Cache
    };

    constructor(connection: Connection) {
        this.connection = connection;
        this.store = {};
        this.storeList = {};

        this.fetchInfo = this.fetchInfo.bind(this);
        this.fetchList = this.fetchList.bind(this);
        this.forceInfoUpdate = this.forceInfoUpdate.bind(this);
        this.forceListUpdate = this.forceListUpdate.bind(this);
    }

    getCacheTime(cache: Cache, default_expire: number, noCache: boolean): number {
        if (!cache.expire) {
            return 0;
        }
        let cacheAge = cache.expire;
        if (noCache) {
            cacheAge -= default_expire + 1000;
        }
        return cacheAge;
    }

    updateCache(cache: Cache, default_expire: number, noCache: boolean) {
        return !cache.data || this.getCacheTime(cache, default_expire, noCache) < Date.now();
    }

    pushToCacheQueue(cache: Cache, item: CacheQueueItem) {
        if (!cache.queue) {
            cache.queue = [];
        }
        cache.queue.push(item);
    }

    async request(cache: Cache, list: string, params: object) {
        const data = await this.connection.send(list, params, {
            expectData: true
        }, 1);
        cache.data = data;
        cache.expire = Date.now() + CACHE_EXPIRE[list];
        if (cache.queue && cache.queue.length) {
            let item: CacheQueueItem;
            while (item = cache.queue.shift()) {
                item.resolve(data);
            }
        } else {
            Log("Cache queue appears to be empty...", this.constructor.name, 3);
        }
    }

    rejectRequest(err: string, cache: Cache) {
        if (cache.queue && cache.queue.length) {
            let item: CacheQueueItem;
            while (item = cache.queue.shift()) {
                item.reject(err);
            }
        } else {
            Log(`Request rejected: ${err}, Cache queue appears to be empty...`, this.constructor.name, 3);
        }
    }

    async handleFetch(cache: Cache, list: string, params: object, resolve: Function, reject: Function) {
        this.pushToCacheQueue(cache, {
            resolve,
            reject
        });
        if (!cache.fetching) {
            cache.fetching = true;
            try {
                await this.request(cache, list, params);
            } catch (err) {
                this.rejectRequest(err, cache);
            }
            cache.fetching = false;
        }
    }

    fetchList(list: string, noCache = false): Promise<any[]> {
        if (!this.storeList[list]) {
            this.storeList[list] = new Cache();
        }
        const cache = this.storeList[list];

        return this.fetchPromise(cache, list, noCache);
    }

    fetchInfo(list: string, keyName: string, keyValue: string | number, noCache = false): Promise<any> {
        if (!this.store[list]) {
            this.store[list] = {};
        }
        if (!this.store[list][keyValue]) {
            this.store[list][keyValue] = new Cache();
        }
        const cache = this.store[list][keyValue];
        return this.fetchPromise(cache, list, noCache, {
            [keyName]: keyValue
        });
    }

    fetchPromise(cache: Cache, list: string, noCache: boolean, params = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.updateCache(cache, CACHE_EXPIRE[list], noCache)) {
                Log(`Fetching resource ${list} ${Object.entries(params)}`, this.constructor.name, 4);
                this.handleFetch(cache, list, params, resolve, reject);
            } else {
                Log(`Using cache (update in ${Math.ceil( (cache.expire - Date.now()) / 1000 ) }s) for resource: ${list} ${Object.entries(params)}`, this.constructor.name, 4);
                resolve(cache.data);
            }
        });
    }

    forceInfoUpdate(list: string, id: string | number, args: object) {
        if (this.store[list] && this.store[list][id]) {
            this.store[list][id].data = {
                ...this.store[list][id].data,
                ...args
            };
        }
    }
    forceListUpdate(list: string, key: string, id: string | number, args: object) {
        if (this.storeList[list]) {
            for (let i = 0, len = this.storeList[list].length(); i < len; i++) {
                if (this.storeList[list][i][key] === id) {
                    this.storeList[list][i][key].data = {
                        ...this.storeList[list][i][id].data,
                        ...args
                    };
                    break;
                }
            }
        }
    }
}
