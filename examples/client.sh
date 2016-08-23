#!/bin/sh
curvecpclient $SERVER_HOSTNAME $SERVER_KEY $SERVER_IP $SERVER_PORT $SERVER_EXTENSION curvecpmessage -cv sh -c "exec cat<&6"
