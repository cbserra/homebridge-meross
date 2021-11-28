/* jshint node: true, esversion: 10, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

const { default: PQueue } = require('p-queue')
const { TimeoutError } = require('p-timeout')

module.exports = class deviceHumidifier {
  constructor (platform, accessory) {
    // Set up variables from the platform
    this.colourUtils = platform.colourUtils
    this.cusChar = platform.cusChar
    this.funcs = platform.funcs
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.accessory = accessory
    // this.enableLogging = accessory.context.enableLogging
    // this.enableDebugLogging = accessory.context.enableDebugLogging
    this.enableLogging = true
    this.enableDebugLogging = true
    this.name = accessory.displayName
    this.pollInterval =
      accessory.context.connection !== 'local'
        ? this.funcs.hasProperty(platform.config, 'cloudRefreshRate')
          ? platform.config.cloudRefreshRate
          : platform.consts.defaultValues.cloudRefreshRate
        : this.funcs.hasProperty(platform.config, 'refreshRate')
        ? platform.config.refreshRate
        : platform.consts.defaultValues.refreshRate
    this.hk2mr = speed => {
      if (speed === 0) {
        return 0
      } else if (speed <= 75) {
        return 2
      } else {
        return 1
      }
    }
    this.hk2Label = speed => {
      if (speed === 0) {
        return 'off'
      } else if (speed <= 75) {
        return 'intermittent'
      } else {
        return 'continuous'
      }
    }
    this.mr2hk = speed => {
      if (speed === 0) {
        return 0
      } else if (speed === 1) {
        return 100
      } else {
        return 50
      }
    }

    // Add the switch service if it doesn't already exist
    this.fanService =
      this.accessory.getService(this.hapServ.Fan) || this.accessory.addService(this.hapServ.Fan)

    // Add the set handler to the fan on/off characteristic
    this.fanService
      .getCharacteristic(this.hapChar.On)
      .onSet(async value => await this.internalFanStateUpdate(value))
    this.cacheFanState = this.fanService.getCharacteristic(this.hapChar.On).value

    // Add the set handler to the fan speed characteristic
    this.fanService
      .getCharacteristic(this.hapChar.RotationSpeed)
      .setProps({
        minStep: 50,
        validValues: [0, 50, 100]
      })
      .onSet(async value => await this.internalFanSpeedUpdate(value))
    this.cacheFanSpeed = this.hk2mr(
      this.fanService.getCharacteristic(this.hapChar.RotationSpeed).value
    )

    // Create the queue used for sending device requests
    this.updateInProgress = false
    this.queue = new PQueue({
      concurrency: 1,
      interval: 250,
      intervalCap: 1,
      timeout: 10000,
      throwOnTimeout: true
    })
    this.queue.on('idle', () => {
      this.updateInProgress = false
    })

    // Set up the mqtt client for cloud devices to send and receive device updates
    if (accessory.context.connection !== 'local') {
      this.accessory.mqtt = new (require('./../connection/mqtt'))(platform, this.accessory)
      this.accessory.mqtt.connect()
    }

    // Always request a device update on startup, then start the interval for polling
    this.requestUpdate(true)
    this.accessory.refreshInterval = setInterval(
      () => this.requestUpdate(),
      this.pollInterval * 1000
    )

    // Output the customised options to the log
    const opts = JSON.stringify({
      connection: this.accessory.context.connection,
      logging: this.enableDebugLogging ? 'debug' : this.enableLogging ? 'standard' : 'disable'
    })
    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, opts)
  }

  async internalFanStateUpdate (value) {
    try {
      // Add the request to the queue so updates are send apart
      return await this.queue.add(async () => {
        // Don't continue if the state is the same as before
        if (value === this.cacheFanState) {
          return
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Spray'
        const payload = {
          spray: {
            mode: value ? Math.max(this.cacheFanSpeed, 1) : 0,
            channel: 0
          }
        }

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload
        })

        // Update the cache and log the update has been successful
        this.cacheFanState = value
        if (this.enableLogging) {
          this.log('[%s] current state [%s].', this.name, value ? 'on' : 'off')
        }
      })
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? this.lang.timeout : this.funcs.parseError(err)
      this.log.warn('[%s] %s %s.', this.name, this.lang.sendFailed, eText)
      setTimeout(() => {
        this.fanService.updateCharacteristic(this.hapChar.On, this.cacheFanState)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalFanSpeedUpdate (value) {
    try {
      // Add the request to the queue so updates are send apart
      return await this.queue.add(async () => {
        // Some homekit apps might not support the valid values of 0, 50 and 100
        if (value === 0) {
          value = 0
        } else if (value <= 75) {
          value = 50
        } else {
          value = 100
        }

        // Don't continue if the state is the same as before
        const mrVal = this.hk2mr(value)
        if (mrVal === this.cacheFanSpeed) {
          return
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Spray'
        const payload = {
          spray: {
            mode: mrVal,
            channel: 0
          }
        }

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload
        })

        // If using the slider to turn off then set the rotation speed back to original value
        // This stops homekit turning back to 100% if using the icon after turned off
        if (value === 0) {
          // Update the rotation speed back to the previous value (with the fan still off)
          setTimeout(() => {
            this.fanService.updateCharacteristic(
              this.hapChar.RotationSpeed,
              this.mr2hk(this.cacheFanSpeed)
            )
          }, 2000)
        } else {
          // Update the cache and log the update has been successful
          this.cacheFanSpeed = mrVal
          if (this.enableLogging) {
            this.log('[%s] current spray [%s].', this.name, this.hk2Label(value))
          }
        }
      })
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? this.lang.timeout : this.funcs.parseError(err)
      this.log.warn('[%s] %s %s.', this.name, this.lang.sendFailed, eText)
      setTimeout(() => {
        this.fanService.updateCharacteristic(
          this.hapChar.RotationSpeed,
          this.mr2hk(this.cacheFanSpeed)
        )
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async requestUpdate (firstRun = false) {
    try {
      // Don't continue if an update is currently being sent to the device
      if (this.updateInProgress) {
        return
      }

      // Add the request to the queue so updates are send apart
      return await this.queue.add(async () => {
        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true

        // Send the request
        const res = await this.platform.sendUpdate(this.accessory, {
          namespace: 'Appliance.System.All',
          payload: {}
        })

        // Log the received data
        if (this.enableDebugLogging) {
          this.log('[%s] %s: %s.', this.name, this.lang.incPoll, JSON.stringify(res.data))
        }

        // Check the response is in a useful format
        const data = res.data.payload

        if (data.all) {
          if (data.all.digest) {
            this.applyUpdate(data.all.digest)
          }

          // A flag to check if we need to update the accessory context
          let needsUpdate = false

          // Get the mac address and hardware version of the device
          if (data.all.system) {
            // Mac address and hardware don't change regularly so only get on first poll
            if (firstRun && data.all.system.hardware) {
              this.accessory.context.macAddress = data.all.system.hardware.macAddress.toUpperCase()
              this.accessory.context.hardware = data.all.system.hardware.version
            }

            // Get the ip address and firmware of the device
            if (data.all.system.firmware) {
              // Check for an IP change each and every time the device is polled
              if (this.accessory.context.ipAddress !== data.all.system.firmware.innerIp) {
                this.accessory.context.ipAddress = data.all.system.firmware.innerIp
                needsUpdate = true
              }

              // Firmware doesn't change regularly so only get on first poll
              if (firstRun) {
                this.accessory.context.firmware = data.all.system.firmware.version
              }
            }
          }

          // Get the cloud online status of the device
          if (data.all.system.online) {
            const isOnline = data.all.system.online.status === 1
            if (this.accessory.context.isOnline !== isOnline) {
              this.accessory.context.isOnline = isOnline
              needsUpdate = true
            }
          }

          // Update the accessory cache if anything has changed
          if (needsUpdate || firstRun) {
            this.platform.updateAccessory(this.accessory)
          }
        }
      })
    } catch (err) {
      const eText = err instanceof TimeoutError ? this.lang.timeout : this.funcs.parseError(err)
      if (this.enableDebugLogging) {
        this.log.warn('[%s] %s %s.', this.name, this.lang.reqFailed, eText)
      }

      // Set the homebridge-ui status of the device to offline if local and error is timeout
      if (
        (this.accessory.context.isOnline || firstRun) &&
        ['EHOSTUNREACH', 'timed out'].some(el => eText.includes(el))
      ) {
        this.accessory.context.isOnline = false
        this.platform.updateAccessory(this.accessory)
      }
    }
  }

  receiveUpdate (params) {
    try {
      // Log the received data
      if (this.enableDebugLogging) {
        this.log('[%s] %s: %s.', this.name, this.lang.incMQTT, JSON.stringify(params))
      }

      // Check the response is in a useful format
      const data = params.payload
      if (data.spray || data.light) {
        this.applyUpdate(data)
      }
    } catch (err) {
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] %s %s.', this.name, this.lang.refFailed, eText)
    }
  }

  applyUpdate (data) {
    // Update the diffuser (fan) service from the supplied data
    if (data.spray && data.spray[0] && this.funcs.hasProperty(data.spray[0], 'mode')) {
      const newSpeed = data.spray[0].mode

      // Check against the cache and update HomeKit and the cache if needed
      if (this.cacheFanSpeed !== newSpeed) {
        this.cacheFanSpeed = newSpeed
        if (this.cacheFanSpeed === 0) {
          // Looks like the spray has been turned off
          this.cacheFanState = false
          this.fanService.updateCharacteristic(this.hapChar.On, false)
          if (this.enableLogging) {
            this.log('[%s] current state [off].', this.name)
          }
        } else {
          // Looks like the spray is now on (from OFF or a different mode)
          if (!this.cacheFanState) {
            // Looks like the spray has been turn ON from OFF
            this.cacheFanState = true
            this.fanService.updateCharacteristic(this.hapChar.On, true)
            if (this.enableLogging) {
              this.log('[%s] current state [on].', this.name)
            }
          }
          const hkValue = this.mr2hk(this.cacheFanSpeed)
          this.fanService.updateCharacteristic(this.hapChar.RotationSpeed, hkValue)
          if (this.enableLogging) {
            this.log('[%s] current spray [%s].', this.name, this.hk2Label(hkValue))
          }
        }
      }
    }
  }
}