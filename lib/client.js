const grpc = require('grpc')
const _ = require('lodash')
const create = require('grpc-create-metadata')
const pc = require('promisify-call')
const maybe = require('call-me-maybe')

const Response = require('./response')

function promisifyClientProto (clientProto) {
  // promisify the client
  _.forOwn(clientProto, (v, k) => {
    if (typeof clientProto[k] === 'function') {
      if (!v.requestStream && !v.responseStream) {
        clientProto[k] = function (arg, metadata, options, fn) {
          if (_.isFunction(options)) {
            fn = options
            options = undefined
          }
          if (_.isFunction(metadata)) {
            fn = metadata
            metadata = undefined
          }
          if (_.isPlainObject(metadata) && metadata instanceof grpc.Metadata === false) {
            metadata = create(metadata)
          }
          const args = _.compact([arg, metadata, options, fn])

          // only promisify-call functions in simple response / request scenario
          return pc(this, v, ...args)
        }
      } else if (!v.requestStream && v.responseStream) {
        clientProto[k] = function (arg, metadata, options) {
          if (_.isPlainObject(metadata) && metadata instanceof grpc.Metadata === false) {
            metadata = create(metadata)
          }
          const args = _.compact([arg, metadata, options])
          return v.call(this, ...args)
        }
      } else if (v.requestStream && !v.responseStream) {
        clientProto[k] = function (metadata, options, fn) {
          if (_.isFunction(options)) {
            fn = options
            options = undefined
          }
          if (_.isFunction(metadata)) {
            fn = metadata
            metadata = undefined
          }
          if (_.isPlainObject(metadata) && metadata instanceof grpc.Metadata === false) {
            metadata = create(metadata)
          }
          if (fn) { // normal call
            const args = _.compact([metadata, options, fn])
            return v.call(this, ...args)
          } else { // dual return promsified call with return { call, res }
            const r = {}
            const p = new Promise((resolve, reject) => {
              const args = _.compact([metadata, options, fn])
              args.push((err, result) => {
                if (err) reject(err)
                else resolve(result)
              })
              r.call = v.call(this, ...args)
            })
            r.res = p
            return r
          }
        }
      } else if (v.requestStream && v.responseStream) {
        clientProto[k] = function (metadata, options) {
          if (_.isPlainObject(metadata) && metadata instanceof grpc.Metadata === false) {
            metadata = create(metadata)
          }
          const args = _.compact([metadata, options])
          return v.call(this, ...args)
        }
      }
    }
  })
}

function expandClientProto (clientProto, _impl) {
  clientProto._exec = function exec (request, fn) {
    const methodName = request.methodName
    if (!_.has(_impl, methodName)) {
      throw new Error(`Invalid method: ${methodName}`)
    }

    const implFn = _impl[methodName].fn

    if ((!implFn.responseStream && implFn.requestStream) ||
      (implFn.responseStream && implFn.requestStream)) {
      throw new Error(`Invalid call: ${methodName} cannot be called using Request API`)
    }

    return maybe(fn, new Promise((resolve, reject) => {
      const { metadata, param, options, responseMetadata, responseStatus } = request

      if (!implFn.responseStream && !implFn.requestStream) {
        const response = new Response()
        const call = this[methodName](param, metadata, options, (err, res) => {
          response.response = res
          if (err) {
            return reject(err)
          }

          return resolve(response)
        })

        response.call = call

        if (responseMetadata) {
          call.on('metadata', md => {
            response.metadata = md
          })
        }

        if (responseStatus) {
          call.on('status', status => {
            response.status = status
          })
        }
      } else if (implFn.responseStream && !implFn.requestStream) {
        const response = new Response()
        const call = this[methodName](metadata, options, (err, res) => {
          response.response = res
          if (err) {
            return reject(err)
          }

          return resolve(response)
        })

        response.call = call

        if (responseMetadata) {
          call.on('metadata', md => {
            response.metadata = md
          })
        }

        if (responseStatus) {
          call.on('status', status => {
            response.status = status
          })
        }
      } else {
        return reject(new Error(`Invalid call: ${methodName} cannot be called using expanded Request API`))
      }
    }))
  }
}

function createClient (protoClientCtor) {
  const clientProto = protoClientCtor.prototype

  const _impl = {}
  _.forOwn(clientProto, (fn, name) => {
    if (typeof clientProto[name] === 'function') {
      if ((!fn.responseStream && !fn.requestStream) ||
        (fn.responseStream && !fn.requestStream) ||
        (!fn.responseStream && fn.requestStream) ||
        (fn.responseStream && fn.requestStream)) {
        _impl[name] = {
          name,
          fn
        }
      }
    }
  })

  promisifyClientProto(clientProto)
  expandClientProto(clientProto, _impl)
}

module.exports = createClient