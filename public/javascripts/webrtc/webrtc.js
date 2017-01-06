/**
 * Created by nghie on 1/5/2017.
 */
var websocket = require('ws');
var kurento = require('kurento-client');
var minimist = require('minimist');

var WebRtc = function (server) {
    var idCounter = 0;
    var candidatesQueue = {};
    var kurentoClient = null;
    var presenter = null;
    var viewers = [];
    var noPresenterMessage = 'No active presenter. Try again later...';
    var argv = minimist(process.argv.slice(2), {
        default: {
            as_uri: 'https://localhost:8443/',
            ws_uri: 'ws://localhost:8888/kurento'
        }
    });


    this.wss = new websocket.Server({
        server : server,
        path : '/one2many'
    });


    /*
     * Management of WebSocket messages
     */
    this.wss.on('connection', function(ws) {
        var sessionId = nextUniqueId();
        console.log('Connection established with sessionId ' + sessionId);

        ws.on('error', function(error) {
            console.log('Connection ' + sessionId + ' error');
            stop(sessionId);
        });

        ws.on('close', function() {
            console.log('Connection ' + sessionId + ' closed');
            stop(sessionId);
        });

        ws.on('message', function(_message) {
            var message = JSON.parse(_message);
            console.log('Connection ' + sessionId + ' received message ', message);

            switch (message.id) {
                case 'presenter':
                    startPresenter(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            return ws.send(JSON.stringify({
                                id : 'presenterResponse',
                                response : 'rejected',
                                message : error
                            }));
                        }
                        ws.send(JSON.stringify({
                            id : 'presenterResponse',
                            response : 'accepted',
                            sdpAnswer : sdpAnswer
                        }));
                    });
                    break;

                case 'viewer':
                    startViewer(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            return ws.send(JSON.stringify({
                                id : 'viewerResponse',
                                response : 'rejected',
                                message : error
                            }));
                        }

                        ws.send(JSON.stringify({
                            id : 'viewerResponse',
                            response : 'accepted',
                            sdpAnswer : sdpAnswer
                        }));
                    });
                    break;

                case 'stop':
                    stop(sessionId);
                    break;

                case 'onIceCandidate':
                    console.log('Receive ICE');
                    onIceCandidate(sessionId, message.candidate);
                    break;

                default:
                    ws.send(JSON.stringify({
                        id : 'error',
                        message : 'Invalid message ' + message
                    }));
                    break;
            }
        });
    });

    function nextUniqueId() {
        idCounter++;
        return idCounter.toString();
    }

    //Recover kurentoClient for the first time.
    function getKurentoClient(callback) {
        if (kurentoClient !== null) {
            return callback(null, kurentoClient);
        }

        kurento(argv.ws_uri, function(error, _kurentoClient) {
            if (error) {
                console.log("Could not find media server at address " + argv.ws_uri);
                return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
            }

            kurentoClient = _kurentoClient;
            callback(null, kurentoClient);
        });
    }

    function startPresenter(sessionId, ws, sdpOffer, callback) {
        console.log("-->> startPresenter");
        clearCandidatesQueue(sessionId);

        if (presenter !== null) {
            stop(sessionId);
            console.log("Another user is currently acting as presenter. Try again later ...");
            return callback("Another user is currently acting as presenter. Try again later ...");
        }

        presenter = {
            id : sessionId,
            pipeline : null,
            webRtcEndpoint : null
        };

        getKurentoClient(function(error, kurentoClient) {
            console.log('get Kurento Client');
            if (error) {
                stop(sessionId);
                return callback(error);
            }

            if (presenter === null) {
                stop(sessionId);
                return callback(noPresenterMessage);
            }

            kurentoClient.create('MediaPipeline', function(error, pipeline) {
                if (error) {
                    stop(sessionId);
                    return callback(error);
                }

                if (presenter === null) {
                    stop(sessionId);
                    return callback(noPresenterMessage);
                }

                presenter.pipeline = pipeline;
                pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }

                    if (presenter === null) {
                        stop(sessionId);
                        return callback(noPresenterMessage);
                    }

                    presenter.webRtcEndpoint = webRtcEndpoint;

                    if (candidatesQueue[sessionId]) {
                        while(candidatesQueue[sessionId].length) {
                            var candidate = candidatesQueue[sessionId].shift();
                            webRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    webRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            stop(sessionId);
                            return callback(error);
                        }

                        if (presenter === null) {
                            stop(sessionId);
                            return callback(noPresenterMessage);
                        }

                        callback(null, sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            stop(sessionId);
                            return callback(error);
                        }
                    });
                });
            });
        });
    }

    function startViewer(sessionId, ws, sdpOffer, callback) {
        clearCandidatesQueue(sessionId);

        if (presenter === null) {
            stop(sessionId);
            return callback(noPresenterMessage);
        }
        if(!presenter.pipeline){
            console.log("Session terminated, cannot create Endpoint");
            return;
        }
        presenter.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
            if (error) {
                stop(sessionId);
                return callback(error);
            }
            viewers[sessionId] = {
                "webRtcEndpoint" : webRtcEndpoint,
                "ws" : ws
            };

            if (presenter === null) {
                stop(sessionId);
                return callback(noPresenterMessage);
            }

            if (candidatesQueue[sessionId]) {
                while(candidatesQueue[sessionId].length) {
                    var candidate = candidatesQueue[sessionId].shift();
                    webRtcEndpoint.addIceCandidate(candidate);
                }
            }

            webRtcEndpoint.on('OnIceCandidate', function(event) {
                var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                ws.send(JSON.stringify({
                    id : 'iceCandidate',
                    candidate : candidate
                }));
            });

            webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    stop(sessionId);
                    return callback(error);
                }
                if (presenter === null) {
                    stop(sessionId);
                    return callback(noPresenterMessage);
                }

                presenter.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }
                    if (presenter === null) {
                        stop(sessionId);
                        return callback(noPresenterMessage);
                    }

                    callback(null, sdpAnswer);
                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            stop(sessionId);
                            return callback(error);
                        }
                    });
                });
            });
        });
    }

    function clearCandidatesQueue(sessionId) {
        if (candidatesQueue[sessionId]) {
            delete candidatesQueue[sessionId];
        }
    }

    function stop(sessionId) {
        if (presenter !== null && presenter.id == sessionId) {
            for (var i in viewers) {
                var viewer = viewers[i];
                if (viewer.ws) {
                    viewer.ws.send(JSON.stringify({
                        id : 'stopCommunication'
                    }));
                }
            }
            if(presenter.pipeline){
                presenter.pipeline.release();
            }
            presenter = null;
            viewers = [];

        } else if (viewers[sessionId]) {
            viewers[sessionId].webRtcEndpoint.release();
            delete viewers[sessionId];
        }

        clearCandidatesQueue(sessionId);
    }

    function onIceCandidate(sessionId, _candidate) {
        console.info('-->> onIceCandidate');
        if(!sessionId) {
            console.log('Session Id is null');
            return;
        }

        var candidate = kurento.getComplexType('IceCandidate')(_candidate);

        if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
            console.info('Sending presenter candidate');
            presenter.webRtcEndpoint.addIceCandidate(candidate);
        }
        else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
            console.info('Sending viewer candidate');
            viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
        }
        else {

            if (!candidatesQueue[sessionId]) {
                candidatesQueue[sessionId] = [];
            }
            console.info('Queueing candidate');
            console.info(candidate);
            if(candidatesQueue[sessionId]){
                console.info('sessionId: %s', sessionId);
                candidatesQueue[sessionId].push(candidate);
            }

        }
    }

};

//Export this class
module.exports = WebRtc;
