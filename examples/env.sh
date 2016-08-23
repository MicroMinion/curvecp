#!/bin/sh

export SERVER_KEYDIR='server'

if [ ! -d $SERVER_KEYDIR ]
then
  curvecpmakekey $SERVER_KEYDIR
fi

export SERVER_HOSTNAME="thomas-XPS"
export SERVER_IP="127.0.0.1"
export SERVER_PORT="9013"
export SERVER_EXTENSION="00000000000000000000000000000000"
export SERVER_KEY=$(curvecpprintkey $SERVER_KEYDIR)
