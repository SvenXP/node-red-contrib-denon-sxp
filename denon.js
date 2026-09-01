/**
 * Created by aborovsky on 27.08.2015.
 */

const util = require('util'),
    debug = require('debug')('node-red-contrib-denon'),
    connectionFSM = require('./lib/connectionFSM.js');

module.exports = function (RED) {

    /**
     * ====== Denon-controller ================
     * Holds configuration for denonjs host+port,
     * initializes new denonjs connections
     * =======================================
     */
    function DenonControllerNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.host = config.host;
        this.port = config.port;
        this.denon = null;
        var node = this;

        /**
         * Initialize an denon_telnet socket, calling the handler function
         * when successfully connected, passing it the denon_telnet connection
         */
        this.initializeDenonConnection = function (handler) {
            if (node.denon) {
                debug(`${node.name}: already configured connection to Denon[${config.host}:${config.port}`);
                if (handler && (typeof handler === 'function')) {
                    if (node.denon.connection && node.denon.connected)
                        handler(node.denon);
                    else {
                        if (node.denon.connection && !node.denon.connected)
                            node.denon.connect();
                        node.denon.on('connected', function () {
                            handler(node.denon);
                        });

                    }
                }
                return node.denon;
            }
            debug(`${node.name}: initializing connection to Denon[${config.host}:${config.port}`);
            node.denon = new connectionFSM({
                host: config.host,
                port: config.port,
                debug: false
            });
            node.denon.connect();
            if (handler && (typeof handler === 'function')) {
                node.denon.on('connected', function () {
                    handler(node.denon);
                });
            }
            debug(`${node.name}: successfully connected to to Denon[${config.host}:${config.port}`);
            return node.denon;
        };
        this.on("close", function () {
            debug(`${node.name}: disconnecting Denon[${config.host}:${config.port}`);
            node.denon && node.denon.disconnect && node.denon.disconnect();
            node.denon = null;
        });
    }

    RED.nodes.registerType("denon-controller", DenonControllerNode);

    /**
     * ====== Denon-out =======================
     * Sends outgoing Denon player from
     * messages received via node-red flows
     * =======================================
     */
    function DenonOut(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        var controllerNode = RED.nodes.getNode(config.controller);
        this.unit_number = config.unit_number;
        this.denoncommand = config.denoncommand;
        var node = this;
        this.on("input", function (msg) {
            debug(node.name, `denonout.onInput msg[${util.inspect(msg)}]`);
            if (!(msg && msg.hasOwnProperty('payload'))) return;
            var payload = msg.payload;
            if (typeof(msg.payload) === "object") {
                payload = msg.payload;
            } else if (typeof(msg.payload) === "string") {
                try {
                    payload = JSON.parse(msg.payload);
                    if (typeof (payload) === 'number')
                        payload = {cmd: msg.payload.toString()};
                } catch (e) {
                    payload = {cmd: msg.payload.toString()};
                }
            }
            else
                payload = {cmd: msg.payload.toString()};
            if (payload == null) {
                node.log('denonout.onInput: illegal msg.payload!');
                return;
            }

            //If msg.topic is filled, than set it as cmd
            if (msg.topic) {
                if (payload.value === null || payload.value === undefined)
                    payload.value = payload.cmd;
                payload = {cmd: msg.topic.toString(), value: payload.value};
            }

            if (node.denoncommand && node.denoncommand !== 'empty') {
                try {
                    payload = JSON.parse(node.denoncommand);
                    if (typeof (payload) === 'number')
                        payload.cmd = node.denoncommand.toString();
                } catch (e) {
                    payload.cmd = node.denoncommand.toString();
                }
            }

            node.send(payload, function (err) {
                if (err) {
                    node.error('send error: ' + err);
                }
                if (typeof(msg.cb) === 'function')
                    msg.cb(err);
            });

        });
        this.on("close", function () {
            node.log('denonOut.close');
        });

        node.status({fill: "yellow", shape: "dot", text: "inactive"});

        function nodeStatusConnected() {
            node.status({fill: "green", shape: "dot", text: "connected"});
        }

        function nodeStatusDisconnected() {
            node.status({fill: "red", shape: "dot", text: "disconnected"});
        }

        function nodeStatusReconnect() {
            node.status({fill: "yellow", shape: "ring", text: "reconnecting"});
        }

        function nodeStatusConnecting() {
            node.status({fill: "green", shape: "ring", text: "connecting"});
        }

        controllerNode.initializeDenonConnection(function (fsm) {
            if (fsm.connected)
                nodeStatusConnected();
            else
                nodeStatusDisconnected();
            fsm.off('connecting', nodeStatusConnecting);
            fsm.on('connecting', nodeStatusConnecting);
            fsm.off('connected', nodeStatusConnected);
            fsm.on('connected', nodeStatusConnected);
            fsm.off('disconnected', nodeStatusDisconnected);
            fsm.on('disconnected', nodeStatusDisconnected);
            fsm.off('reconnect', nodeStatusReconnect);
            fsm.on('reconnect', nodeStatusReconnect);
        });

        this.send = function (data, callback) {
            debug(`${node.name}: send data[${JSON.stringify(data)}]`);
            controllerNode.initializeDenonConnection(function (fsm) {
                try {
                    data.cmd = (data.cmd || data.method || '').toString().trim();
                    data.value = data.value || data.params;

                    if (!data.cmd && !data.value) {
                        if (callback) callback(new Error('Empty command'));
                        return;
                    }

                    const rawCmd = data.cmd.toUpperCase();
                    const socket = fsm.connection && typeof fsm.connection.getConnection === 'function' ? fsm.connection.getConnection() : null;

                    // Dedicated high-level helper if available and desired
                    if (rawCmd === 'SETVOLUMEDB' && typeof fsm.connection.setVolumeDb === 'function') {
                        fsm.connection.setVolumeDb(parseFloat(data.value), function (error, response) {
                            if (callback) callback(error, response);
                        });
                        return;
                    }

                    // Determine command string to send
                    let sendStr = data.cmd;
                    if (data.value !== undefined && data.value !== null && data.value !== '') {
                        sendStr += data.value.toString();
                    }

                    // Ensure carriage return formatting if writing directly
                    const asciiCmd = sendStr.replace(/\r?\n?$/, '');

                    // Determine dynamic timeout: Power on / zone power on needs more time (8000ms)
                    const isPowerBoot = /^(PWON|ZMON|ZM\s*ON|PW\s*ON)/i.test(asciiCmd);
                    const timeoutMs = isPowerBoot ? 8000 : (data.timeout || 3000);

                    // If denon connection client supports send with timeout or raw socket write:
                    // Prefer direct socket write to prevent library queue deadlock on asynchronous status responses
                    if (socket && typeof socket.write === 'function' && socket.writable) {
                        socket.write(asciiCmd + '\r', function (err) {
                            if (callback) callback(err, { cmd: asciiCmd, status: err ? 'error' : 'sent' });
                        });
                    } else if (typeof fsm.connection.send === 'function') {
                        // Fallback to library send method with safe prefix matching
                        const prefix = asciiCmd.length >= 2 ? asciiCmd.substring(0, 2) : '';
                        let responded = false;
                        const timer = setTimeout(function () {
                            if (!responded) {
                                responded = true;
                                if (callback) callback(null, { cmd: asciiCmd, status: 'dispatched_timeout_ignored' });
                            }
                        }, timeoutMs);

                        fsm.connection.send(asciiCmd, prefix, function (error, response) {
                            if (!responded) {
                                responded = true;
                                clearTimeout(timer);
                                if (callback) callback(error, response);
                            }
                        });
                    } else {
                        throw new Error('No active Denon connection available');
                    }
                }
                catch (err) {
                    node.error('error calling send: ' + err);
                    if (callback) callback(err);
                }
            });
        };
    }

    //
    RED.nodes.registerType("denon-out", DenonOut);

    /**
     * ====== Denon-IN ========================
     * Handles incoming Global Cache, injecting
     * json into node-red flows
     * =======================================
     */
    function DenonIn(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.connection = null;
        var node = this;
        var controllerNode = RED.nodes.getNode(config.controller);

        /* ===== Node-Red events ===== */
        function nodeStatusConnecting() {
            node.status({fill: "green", shape: "ring", text: "connecting"});
        }

        function nodeStatusConnected() {
            node.status({fill: "green", shape: "dot", text: "connected"});
        }

        function nodeStatusDisconnected() {
            node.status({fill: "red", shape: "dot", text: "disconnected"});
        }

        function nodeStatusReconnect() {
            node.status({fill: "yellow", shape: "ring", text: "reconnecting"});
        }

        function receiveNotification(data) {
            debug(`${node.name}: receiveNotification data[${JSON.stringify(data)}`);
            node.send({
                topic: 'denon',
                payload: data
            });
        };

        controllerNode.initializeDenonConnection(function (fsm) {
            if (fsm.connected)
                nodeStatusConnected();
            else
                nodeStatusDisconnected();
            fsm.off('connecting', nodeStatusConnecting);
            fsm.on('connecting', nodeStatusConnecting);
            fsm.off('connected', nodeStatusConnected);
            fsm.on('connected', nodeStatusConnected);
            fsm.off('disconnected', nodeStatusDisconnected);
            fsm.on('disconnected', nodeStatusDisconnected);
            fsm.off('reconnect', nodeStatusReconnect);
            fsm.on('reconnect', nodeStatusReconnect);
            fsm.off('data', receiveNotification);
            fsm.on('data', receiveNotification);
        });
    }

    RED.nodes.registerType("denon-in", DenonIn);
}