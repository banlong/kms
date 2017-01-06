angular.module('socket')
        .factory('SocketIO', function () {
            //console.log("-->>SocketIO started");
            //signalServerIp = "https://" + window.location.hostname +  ":8443";
            //var ws = io.connect(signalServerIp);
            //var ws = io.connect('https://localhost:8443', {secure: true});
            var ws = new WebSocket('wss://' + location.host + '/one2many' );
            return ws;
        });





