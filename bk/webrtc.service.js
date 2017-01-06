/**
 * Created by nghie on 1/5/2017.
 */
angular.module('socket')
    .factory('WebRtc', function () {
        return {
            getKurentoClient: getKurentoClient,
            startPresenter: startPresenter,
            startViewer: startViewer,
            clearCandidatesQueue: clearCandidatesQueue,
            stop:stop,
            onIceCandidate:onIceCandidate
        };


        // Recover kurentoClient for the first time.
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
    });
