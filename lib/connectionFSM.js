const net = require('net');
const machina = require('machina');
const debug = require('debug')('node-red-contrib-denon:fsm');

module.exports = function (options) {
    const connectionFSM = new machina.Fsm({
        debug: options.debug ? true : false,
        host: options.host || '127.0.0.1',
        port: options.port || 23,
        CONNECT_TIMEOUT: options.connectTimeout || options['connect-timeout'] || 10000,
        PING_TIMEOUT: options.pingTimeout || options['ping-timeout'] || 5000,
        PING_INTERVAL: options.pingInterval || options['ping-interval'] || 60000,
        RECONNECT_INTERVAL: options.reconnectInterval || options['reconnect-interval'] || 5000,
        
        initialize: function () {
            this.connected = false;
            this.disconnectingManually = false;
            this.socket = null;
            this.buffer = '';
        },
        
        namespace: "denon-connection",
        initialState: "uninitialized",
        
        states: {
            uninitialized: {
                "*": function () {
                    this.deferUntilTransition();
                    this.transition("connecting");
                }
            },
            connecting: {
                _onEnter: function () {
                    const self = this;
                    this.disconnectingManually = false;
                    this.connected = false;
                    this.emit('connecting');
                    debug(`Connecting to ${this.host}:${this.port}`);

                    this.connectingTimeout = setTimeout(function () {
                        debug('Connection timeout triggered');
                        self.transition("scheduleReconnect");
                    }, this.CONNECT_TIMEOUT);

                    const socket = this.socket = new net.Socket();
                    socket.setKeepAlive(true, 10000);

                    socket.on('connect', function () {
                        debug(`Connected to ${self.host}:${self.port}`);
                        self.transition("connected");
                    });

                    socket.on('data', function (data) {
                        self.handleIncomingData(data);
                    });

                    function errorHandler(err) {
                        debug(`Socket error: ${err}`);
                        if (!self.disconnectingManually) {
                            self.transition('scheduleReconnect');
                        }
                    }

                    socket.on('error', errorHandler);
                    socket.on('close', function () {
                        debug('Socket closed');
                        if (!self.disconnectingManually) {
                            self.handle('scheduleReconnect');
                        }
                    });
                    socket.on('end', function () {
                        debug('Socket ended');
                        if (!self.disconnectingManually) {
                            self.handle('scheduleReconnect');
                        }
                    });

                    socket.connect({
                        host: this.host,
                        port: this.port
                    });
                },
                _onExit: function () {
                    clearTimeout(this.connectingTimeout);
                }
            },
            scheduleReconnect: {
                _onEnter: function () {
                    const self = this;
                    this.connected = false;
                    this.emit('disconnected');
                    if (this.socket) {
                        this.socket.destroy();
                        this.socket = null;
                    }
                    clearTimeout(this.connectingTimeout);
                    this.emit('reconnect');
                    debug(`Reconnecting in ${this.RECONNECT_INTERVAL}ms...`);
                    this.reconnectTimer = setTimeout(function () {
                        self.transition("connecting");
                    }, this.RECONNECT_INTERVAL);
                },
                _onExit: function () {
                    clearTimeout(this.reconnectTimer);
                }
            },
            connected: {
                _onEnter: function () {
                    const self = this;
                    if (!this.connected) {
                        this.connected = true;
                        this.emit('connected');
                    }
                    this.pingTimer = setTimeout(function () {
                        self.transition("pinging");
                    }, this.PING_INTERVAL);
                },
                _onExit: function () {
                    clearTimeout(this.pingTimer);
                }
            },
            pinging: {
                _onEnter: function () {
                    const self = this;
                    let pongReceived = false;

                    this.pingTimeout = setTimeout(function () {
                        if (!pongReceived) {
                            debug('Ping timeout triggered');
                            self.transition('connecting');
                        }
                    }, this.PING_TIMEOUT);

                    const onPong = function (data) {
                        if (typeof data === 'string' && (data.startsWith('PW') || data.startsWith('ZM') || data.startsWith('MV') || data.startsWith('SI'))) {
                            pongReceived = true;
                            self.off('data', onPong);
                            self.transition('connected');
                        }
                    };

                    this.on('data', onPong);

                    // Send Denon power query as keepalive ping
                    this.sendAscii('PW?');
                },
                _onExit: function () {
                    clearTimeout(this.pingTimeout);
                }
            },
            disconnecting: {
                _onEnter: function () {
                    this.connected = false;
                    this.disconnectingManually = true;
                    this.emit('disconnected');
                    if (this.socket) {
                        this.socket.destroy();
                        this.socket = null;
                    }
                    this.transition('uninitialized');
                }
            }
        },

        handleIncomingData: function (data) {
            this.buffer += data.toString('ascii');
            const lines = this.buffer.split('\r');
            this.buffer = lines.pop(); // Keep incomplete trailing fragment

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].replace(/[\n\r]/g, '').trim();
                if (line.length > 0) {
                    this.emit('data', line);
                }
            }
        },

        sendAscii: function (cmd, callback) {
            if (!this.socket || !this.connected || !this.socket.writable) {
                const err = new Error('Not connected to Denon AVR');
                if (callback) callback(err);
                return false;
            }
            const formatted = cmd.toString().replace(/[\r\n]+$/, '') + '\r';
            return this.socket.write(formatted, 'ascii', callback);
        },

        // Backward compatibility helper functions
        getConnection: function () {
            return this.socket;
        },

        get connection() {
            return this;
        },

        setVolumeDb: function (level, callback) {
            // Master volume: 80 = 0dB
            let zero = 80;
            let val = parseFloat(level);
            let num = Math.round((val + zero) * 2) / 2;
            let intPart = Math.floor(num);
            let str = (intPart < 10 ? '0' + intPart : intPart.toString());
            if (num % 1 !== 0) {
                str += '5';
            }
            this.sendAscii('MV' + str, callback);
        },

        send: function (cmd, prefix, callback) {
            if (typeof prefix === 'function') {
                callback = prefix;
            }
            this.sendAscii(cmd, callback);
        },

        connect: function () {
            this.handle("_reset");
        },

        disconnect: function () {
            this.transition("disconnecting");
        }
    });

    return connectionFSM;
};
