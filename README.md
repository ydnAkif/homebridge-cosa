# homebridge-cosa

## ydnAkif resilience build

HomeKit reads return cached thermostat state immediately while Cosa Cloud
updates run in the background. Concurrent reads share one request, transient
network failures receive one retry, writes are retried safely, and sensitive
configuration is no longer printed to the Homebridge log.

[![npm](https://img.shields.io/npm/v/homebridge-cosa)](https://www.npmjs.com/package/homebridge-cosa)

Homebridge plugin for [Cosa Smart Thermostat](https://smartcosa.com/intl/).

> Currently work in progress. It works for me but there are missing features and edge-cases that needs to be handled.
