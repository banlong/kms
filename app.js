var express = require('express');
var path = require('path');
var url = require('url');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var minimist = require('minimist');
var websocket = require('ws');

var kurento = require('kurento-client');
var fs    = require('fs');
//var http = require('http');
var https = require('https');
var index = require('./routes/index');
var users = require('./routes/users');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
    {
        key:  fs.readFileSync('keys/server.key'),
        cert: fs.readFileSync('keys/server.crt')
    };

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';
var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

//Using middleware
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', index);
app.use('/users', users);
// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});
// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Server started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

//var wss = require('socket.io').listen(server);

var wss = new websocket.Server({
    server : server,
    path : '/one2many'
});


//var wss = new websocket({ server: server, path : '/one2many' });

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
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

/*
 * Definition of functions
 */

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
module.exports = app;
