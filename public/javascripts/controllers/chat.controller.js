/**
 * Created by nghiepnds on 12/2/2016.
 */
//Declare Module for client side
angular.module('socket', []);

angular.module('socket')
    .controller("Chat", function ($scope) {
        var kmsUri = 'wss://' + location.host + '/one2many';
        var websocket = new WebSocket(kmsUri);
        var webRtcPeer;

        websocket.onmessage = function(message) {
            var parsedMessage = JSON.parse(message.data);
            console.info('Received message: ' + message.data);

            switch (parsedMessage.id) {
                case 'presenterResponse':
                    presenterResponse(parsedMessage);
                    break;
                case 'viewerResponse':
                    viewerResponse(parsedMessage);
                    break;
                case 'stopCommunication':
                    dispose();
                    break;
                case 'iceCandidate':
                    webRtcPeer.addIceCandidate(parsedMessage.candidate);
                    break;
                default:
                    console.error('Unrecognized message', parsedMessage);
            }
        };

        function presenterResponse(message) {
            if (message.response != 'accepted') {
                var errorMsg = message.message ? message.message : 'Unknow error';
                console.warn('Call not accepted for the following reason: ' + errorMsg);
                dispose();
            } else {
                webRtcPeer.processAnswer(message.sdpAnswer);
            }
        }

        function viewerResponse(message) {
            if (message.response != 'accepted') {
                var errorMsg = message.message ? message.message : 'Unknow error';
                console.warn('Call not accepted for the following reason: ' + errorMsg);
                dispose();
            } else {
                webRtcPeer.processAnswer(message.sdpAnswer);
            }
        }

        $scope.presenter =  function presenter() {
            console.log("-->> called presenter()");
            if (!webRtcPeer) {
                showSpinner(video);

                var options = {
                    localVideo: video,
                    onicecandidate : onIceCandidate
                };

                webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function(error) {
                    console.log('-->> creating the webTrcPeer');
                    if(error){
                        console.log(error);
                        return onError(error);
                    }

                    this.generateOffer(onOfferPresenter);
                });
            }
        };

        function onOfferPresenter(error, offerSdp) {
            if (error) return onError(error);

            var message = {
                id : 'presenter',
                sdpOffer : offerSdp
            };
            sendMessage(message);
        }

        $scope.viewer = function() {
            if (!webRtcPeer) {
                showSpinner(video);

                var options = {
                    remoteVideo: video,
                    onicecandidate : onIceCandidate
                };

                webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function(error) {
                    if(error) return onError(error);

                    this.generateOffer(onOfferViewer);
                });
            }
        };

        $scope.stop = function() {
            if (webRtcPeer) {
                var message = {
                    id : 'stop'
                };
                sendMessage(message);
                dispose();
            }
        };

        function onOfferViewer(error, offerSdp) {
            if (error) return onError(error);

            var message = {
                id : 'viewer',
                sdpOffer : offerSdp
            };
            sendMessage(message);
        }

        function onIceCandidate(candidate) {
            console.log('Local candidate' + JSON.stringify(candidate));

            var message = {
                id : 'onIceCandidate',
                candidate : candidate
            };
            sendMessage(message);
        }

        function dispose() {
            if (webRtcPeer) {
                webRtcPeer.dispose();
                webRtcPeer = null;
            }
            hideSpinner(video);
        }

        function sendMessage(message) {
            var jsonMessage = JSON.stringify(message);
            console.log('Sending message: ' + jsonMessage);
            websocket.send(jsonMessage);
        }

        function showSpinner() {
            for (var i = 0; i < arguments.length; i++) {
                arguments[i].poster = './images/transparent-1px.png';
                arguments[i].style.background = 'center transparent url("./images/spinner.gif") no-repeat';
            }
        }

        function hideSpinner() {
            for (var i = 0; i < arguments.length; i++) {
                arguments[i].src = '';
                arguments[i].poster = './images/webrtc.png';
                arguments[i].style.background = '';
            }
        }


        window.onbeforeunload = function() {
            websocket.close();
        };

    });



