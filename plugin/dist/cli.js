#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/graceful-fs/polyfills.js"(exports, module) {
    var constants = __require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module.exports = patch;
    function patch(fs) {
      if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
          function rename2(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename2, fs$rename);
          return rename2;
        })(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      })(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path, mode, callback) {
          fs2.open(
            path,
            constants.O_WRONLY | constants.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path, mode) {
          var fd = fs2.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path, at, mt, cb) {
            fs2.open(path, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path, at, mt) {
            var fd = fs2.openSync(path, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/graceful-fs/legacy-streams.js"(exports, module) {
    var Stream = __require("stream").Stream;
    module.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path, options);
        Stream.call(this);
        var self = this;
        this.path = path;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path, options);
        Stream.call(this);
        this.path = path;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/graceful-fs/clone.js"(exports, module) {
    "use strict";
    module.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/graceful-fs/graceful-fs.js"(exports, module) {
    var fs = __require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = __require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = /* @__PURE__ */ Symbol.for("graceful-fs.queue");
      previousSymbol = /* @__PURE__ */ Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs.close);
      fs.closeSync = (function(fs$closeSync) {
        function closeSync2(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync2, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync2;
      })(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          __require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile;
      function readFile(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path, options, cb);
        function go$readFile(path2, options2, cb2, startTime) {
          return fs$readFile(path2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile2;
      function writeFile2(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path, data, options, cb);
        function go$writeFile(path2, data2, options2, cb2, startTime) {
          return fs$writeFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path, data, options, cb);
        function go$appendFile(path2, data2, options2, cb2, startTime) {
          return fs$appendFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir2;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir2(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, options2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path, options, cb);
        function fs$readdirCallback(path2, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path2, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path, options) {
        return new fs2.ReadStream(path, options);
      }
      function createWriteStream(path, options) {
        return new fs2.WriteStream(path, options);
      }
      var fs$open = fs2.open;
      fs2.open = open;
      function open(path, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path, flags, mode, cb);
        function go$open(path2, flags2, mode2, cb2, startTime) {
          return fs$open(path2, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts;
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/signal-exit/signals.js"(exports, module) {
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/signal-exit/index.js"(exports, module) {
    var process2 = global.process;
    var processOk = function(process3) {
      return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
    };
    if (!processOk(process2)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process2.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process2.__signal_exit_emitter__) {
        emitter = process2.__signal_exit_emitter__;
      } else {
        emitter = process2.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(global.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        };
        emitter.on(ev, cb);
        return remove;
      };
      unload = function unload2() {
        if (!loaded || !processOk(global.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process2.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process2.emit = originalProcessEmit;
        process2.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      };
      module.exports.unload = unload;
      emit = function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      };
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = function listener() {
          if (!processOk(global.process)) {
            return;
          }
          var listeners = process2.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process2.kill(process2.pid, sig);
          }
        };
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = function load2() {
        if (loaded || !processOk(global.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process2.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process2.emit = processEmit;
        process2.reallyExit = processReallyExit;
      };
      module.exports.load = load;
      originalProcessReallyExit = process2.reallyExit;
      processReallyExit = function processReallyExit2(code) {
        if (!processOk(global.process)) {
          return;
        }
        process2.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        originalProcessReallyExit.call(process2, process2.exitCode);
      };
      originalProcessEmit = process2.emit;
      processEmit = function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(global.process)) {
          if (arg !== void 0) {
            process2.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process2.exitCode, null);
          emit("afterexit", process2.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      };
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
    "use strict";
    var cacheSymbol = /* @__PURE__ */ Symbol();
    function probe(file, fs, callback) {
      const cachedPrecision = fs[cacheSymbol];
      if (cachedPrecision) {
        return fs.stat(file, (err, stat) => {
          if (err) {
            return callback(err);
          }
          callback(null, stat.mtime, cachedPrecision);
        });
      }
      const mtime = new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
      fs.utimes(file, mtime, mtime, (err) => {
        if (err) {
          return callback(err);
        }
        fs.stat(file, (err2, stat) => {
          if (err2) {
            return callback(err2);
          }
          const precision = stat.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
          Object.defineProperty(fs, cacheSymbol, { value: precision });
          callback(null, stat.mtime, precision);
        });
      });
    }
    function getMtime(precision) {
      let now = Date.now();
      if (precision === "s") {
        now = Math.ceil(now / 1e3) * 1e3;
      }
      return new Date(now);
    }
    module.exports.probe = probe;
    module.exports.getMtime = getMtime;
  }
});

// node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var fs = require_graceful_fs();
    var retry = require_retry2();
    var onExit = require_signal_exit();
    var mtimePrecision = require_mtime_precision();
    var locks = {};
    function getLockFile(file, options) {
      return options.lockfilePath || `${file}.lock`;
    }
    function resolveCanonicalPath(file, options, callback) {
      if (!options.realpath) {
        return callback(null, path.resolve(file));
      }
      options.fs.realpath(file, callback);
    }
    function acquireLock2(file, options, callback) {
      const lockfilePath = getLockFile(file, options);
      options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
          return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
            if (err2) {
              options.fs.rmdir(lockfilePath, () => {
              });
              return callback(err2);
            }
            callback(null, mtime, mtimePrecision2);
          });
        }
        if (err.code !== "EEXIST") {
          return callback(err);
        }
        if (options.stale <= 0) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        options.fs.stat(lockfilePath, (err2, stat) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return acquireLock2(file, { ...options, stale: 0 }, callback);
            }
            return callback(err2);
          }
          if (!isLockStale(stat, options)) {
            return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
          }
          removeLock(file, options, (err3) => {
            if (err3) {
              return callback(err3);
            }
            acquireLock2(file, { ...options, stale: 0 }, callback);
          });
        });
      });
    }
    function isLockStale(stat, options) {
      return stat.mtime.getTime() < Date.now() - options.stale;
    }
    function removeLock(file, options, callback) {
      options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== "ENOENT") {
          return callback(err);
        }
        callback();
      });
    }
    function updateLock(file, options) {
      const lock2 = locks[file];
      if (lock2.updateTimeout) {
        return;
      }
      lock2.updateDelay = lock2.updateDelay || options.update;
      lock2.updateTimeout = setTimeout(() => {
        lock2.updateTimeout = null;
        options.fs.stat(lock2.lockfilePath, (err, stat) => {
          const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
          if (err) {
            if (err.code === "ENOENT" || isOverThreshold) {
              return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1e3;
            return updateLock(file, options);
          }
          const isMtimeOurs = lock2.mtime.getTime() === stat.mtime.getTime();
          if (!isMtimeOurs) {
            return setLockAsCompromised(
              file,
              lock2,
              Object.assign(
                new Error("Unable to update lock within the stale threshold"),
                { code: "ECOMPROMISED" }
              )
            );
          }
          const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
          options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
            const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
            if (lock2.released) {
              return;
            }
            if (err2) {
              if (err2.code === "ENOENT" || isOverThreshold2) {
                return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
              }
              lock2.updateDelay = 1e3;
              return updateLock(file, options);
            }
            lock2.mtime = mtime;
            lock2.lastUpdate = Date.now();
            lock2.updateDelay = null;
            updateLock(file, options);
          });
        });
      }, lock2.updateDelay);
      if (lock2.updateTimeout.unref) {
        lock2.updateTimeout.unref();
      }
    }
    function setLockAsCompromised(file, lock2, err) {
      lock2.released = true;
      if (lock2.updateTimeout) {
        clearTimeout(lock2.updateTimeout);
      }
      if (locks[file] === lock2) {
        delete locks[file];
      }
      lock2.options.onCompromised(err);
    }
    function lock(file, options, callback) {
      options = {
        stale: 1e4,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => {
          throw err;
        },
        ...options
      };
      options.retries = options.retries || 0;
      options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
      options.stale = Math.max(options.stale || 0, 2e3);
      options.update = options.update == null ? options.stale / 2 : options.update || 0;
      options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const operation = retry.operation(options.retries);
        operation.attempt(() => {
          acquireLock2(file2, options, (err2, mtime, mtimePrecision2) => {
            if (operation.retry(err2)) {
              return;
            }
            if (err2) {
              return callback(operation.mainError());
            }
            const lock2 = locks[file2] = {
              lockfilePath: getLockFile(file2, options),
              mtime,
              mtimePrecision: mtimePrecision2,
              options,
              lastUpdate: Date.now()
            };
            updateLock(file2, options);
            callback(null, (releasedCallback) => {
              if (lock2.released) {
                return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
              }
              unlock(file2, { ...options, realpath: false }, releasedCallback);
            });
          });
        });
      });
    }
    function unlock(file, options, callback) {
      options = {
        fs,
        realpath: true,
        ...options
      };
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const lock2 = locks[file2];
        if (!lock2) {
          return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
        }
        lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
        lock2.released = true;
        delete locks[file2];
        removeLock(file2, options, callback);
      });
    }
    function check(file, options, callback) {
      options = {
        stale: 1e4,
        realpath: true,
        fs,
        ...options
      };
      options.stale = Math.max(options.stale || 0, 2e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        options.fs.stat(getLockFile(file2, options), (err2, stat) => {
          if (err2) {
            return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
          }
          return callback(null, !isLockStale(stat, options));
        });
      });
    }
    function getLocks() {
      return locks;
    }
    onExit(() => {
      for (const file in locks) {
        const options = locks[file].options;
        try {
          options.fs.rmdirSync(getLockFile(file, options));
        } catch (e) {
        }
      }
    });
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.check = check;
    module.exports.getLocks = getLocks;
  }
});

// node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
    "use strict";
    var fs = require_graceful_fs();
    function createSyncFs(fs2) {
      const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
      const newFs = { ...fs2 };
      methods.forEach((method) => {
        newFs[method] = (...args) => {
          const callback = args.pop();
          let ret;
          try {
            ret = fs2[`${method}Sync`](...args);
          } catch (err) {
            return callback(err);
          }
          callback(null, ret);
        };
      });
      return newFs;
    }
    function toPromise(method) {
      return (...args) => new Promise((resolve3, reject) => {
        args.push((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve3(result);
          }
        });
        method(...args);
      });
    }
    function toSync(method) {
      return (...args) => {
        let err;
        let result;
        args.push((_err, _result) => {
          err = _err;
          result = _result;
        });
        method(...args);
        if (err) {
          throw err;
        }
        return result;
      };
    }
    function toSyncOptions(options) {
      options = { ...options };
      options.fs = createSyncFs(options.fs || fs);
      if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
        throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
      }
      return options;
    }
    module.exports = {
      toPromise,
      toSync,
      toSyncOptions
    };
  }
});

// node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "node_modules/proper-lockfile/index.js"(exports, module) {
    "use strict";
    var lockfile2 = require_lockfile();
    var { toPromise, toSync, toSyncOptions } = require_adapter();
    async function lock(file, options) {
      const release = await toPromise(lockfile2.lock)(file, options);
      return toPromise(release);
    }
    function lockSync(file, options) {
      const release = toSync(lockfile2.lock)(file, toSyncOptions(options));
      return toSync(release);
    }
    function unlock(file, options) {
      return toPromise(lockfile2.unlock)(file, options);
    }
    function unlockSync(file, options) {
      return toSync(lockfile2.unlock)(file, toSyncOptions(options));
    }
    function check(file, options) {
      return toPromise(lockfile2.check)(file, options);
    }
    function checkSync(file, options) {
      return toSync(lockfile2.check)(file, toSyncOptions(options));
    }
    module.exports = lock;
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.lockSync = lockSync;
    module.exports.unlockSync = unlockSync;
    module.exports.check = check;
    module.exports.checkSync = checkSync;
  }
});

// src/indexer/driver.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2 } from "node:fs";
import { basename as basename2, dirname as dirname2 } from "node:path";
import Database from "better-sqlite3";

// src/indexer/append.ts
import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";

// src/indexer/claude_parser.ts
import { homedir } from "node:os";

// src/indexer/shell_writes.ts
import { posix } from "node:path";
var HOLE = "\0";
var WORD_END = /* @__PURE__ */ new Set([" ", "	", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);
var REDIRECT_RE = /^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/;
var OPERATOR_RE = /^(&&|\|\||;;&|;;|;&|;|\|&|\||&)/;
var LEADING_WORDS = /* @__PURE__ */ new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until", "time"]);
function arithmeticEnd(src, at) {
  let depth = 0;
  for (let j = at; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) return j + 1;
      if (depth === 1 && src[j + 1] !== ")") return null;
    }
  }
  return src.length;
}
var MAX_NESTING = 600;
function skipParens(src, open, nesting = 0) {
  if (nesting > MAX_NESTING) return src.length;
  let depth = 0;
  const heredocs = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      i = e === -1 ? src.length : e + 1;
      continue;
    }
    if (c === '"') {
      i = skipDoubleQuoted(src, i, nesting + 1);
      continue;
    }
    if (c === "`") {
      i = skipBackticks(src, i);
      continue;
    }
    if (src.startsWith("<<<", i)) {
      i += 3;
      continue;
    }
    if (c === "<" && src.startsWith("<<", i)) {
      const m = /^<<(-?)\s*(['"]?)([^\s'"();&|<>]+)\2/.exec(src.slice(i, i + 256));
      if (m) {
        heredocs.push({ delim: m[3], strip: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n" && heredocs.length > 0) {
      i = skipHeredocBodies(src, i + 1, heredocs.splice(0)).end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}
function skipDoubleQuoted(src, open, nesting = 0) {
  if (nesting > MAX_NESTING) return src.length;
  let i = open + 1;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "$" || src[i] === "`") i = skipExpansion(src, i, nesting + 1);
    else i++;
  }
  return Math.min(i + 1, src.length);
}
function skipBackticks(src, open) {
  let i = open + 1;
  while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, src.length);
}
function skipExpansion(src, at, nesting = 0) {
  if (src[at] === "`") return skipBackticks(src, at);
  const next = src[at + 1];
  if (next === "(") return skipParens(src, at + 1, nesting + 1);
  if (next === "{") {
    const e = src.indexOf("}", at + 2);
    return e === -1 ? src.length : e + 1;
  }
  const m = /^[A-Za-z_]\w*|^[0-9?$!#@*-]/.exec(src.slice(at + 1, at + 257));
  return at + 1 + (m ? m[0].length : 0);
}
function skipHeredocBodies(src, start, heredocs) {
  let i = start;
  const bodies = [];
  for (const h of heredocs) {
    const lines = [];
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      const line = src.slice(i, end);
      i = nl === -1 ? src.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      lines.push(line);
    }
    bodies.push(lines.join("\n"));
  }
  return { end: i, bodies };
}
function parse(src, home) {
  const items = [];
  let cur = { words: [], redirects: [], sep: "" };
  let pending = [];
  let awaitingDelim = null;
  let awaitingTarget = null;
  let inTest = false;
  const cases = [];
  let i = 0;
  let atStart = true;
  const atCommandStart = () => atStart;
  const finish = (sep) => {
    awaitingTarget = null;
    awaitingDelim = null;
    const last = items.at(-1);
    if (cur.words.length > 0 || cur.redirects.length > 0) {
      cur.sep = sep;
      items.push({ kind: "cmd", cmd: cur });
    } else if (last?.kind === "close" && sep !== "(" && sep !== ")" && sep !== "") {
      last.sep = sep;
    }
    cur = { words: [], redirects: [], sep: "" };
    inTest = false;
    atStart = true;
  };
  const pushWord = (word) => {
    if (awaitingDelim !== null) {
      pending.push({ redirect: awaitingDelim.redirect, delim: word.text, strip: awaitingDelim.strip });
      awaitingDelim = null;
    } else if (awaitingTarget !== null) {
      awaitingTarget.target = word;
      awaitingTarget = null;
    } else if (cases.at(-1) === "pattern") {
      if (word.text === "esac") cases.pop();
    } else if (cur.words.length === 0 && cur.redirects.length === 0 && (word.text === "{" || word.text === "}")) {
      if (word.text === "{") items.push({ kind: "open", group: "brace" });
      else items.push({ kind: "close", group: "brace", sep: "" });
    } else {
      const start = atCommandStart();
      if (!LEADING_WORDS.has(word.text)) atStart = false;
      if (start && word.text === "[[") inTest = true;
      else if (word.text === "]]") inTest = false;
      if (start && word.text === "case") cases.push("head");
      else if (start && word.text === "esac" && cases.at(-1) === "body") cases.pop();
      cur.words.push(word);
      if (cases.at(-1) === "head" && word.text === "in") {
        finish("");
        cases[cases.length - 1] = "pattern";
      }
    }
  };
  const readWord = () => {
    let text = "";
    let literal = true;
    if (src[i] === "~") {
      const after = src[i + 1];
      if (home !== null && (after === void 0 || after === "/" || WORD_END.has(after))) {
        text = home;
        i++;
      } else {
        literal = false;
      }
    }
    while (i < src.length) {
      const c = src[i];
      if (WORD_END.has(c) && !(inTest && (c === "<" || c === ">"))) break;
      if (c === "\\") {
        if (src[i + 1] !== "\n") text += src[i + 1] ?? "";
        i += 2;
      } else if (c === "'") {
        const e = src.indexOf("'", i + 1);
        const end = e === -1 ? src.length : e;
        text += src.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i];
          if (d === "\\" && i + 1 < src.length) {
            const n = src[i + 1];
            if ('$`"\\\n'.includes(n)) {
              if (n !== "\n") text += n;
            } else text += d + n;
            i += 2;
          } else if (d === "$" || d === "`") {
            literal = false;
            text += HOLE;
            i = skipExpansion(src, i);
          } else {
            text += d;
            i++;
          }
        }
        i++;
      } else if (c === "$" && src[i + 1] === "'") {
        literal = false;
        text += HOLE;
        i += 2;
        while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
        i++;
      } else if (c === "$" && src[i + 1] === '"') {
        i++;
      } else if (c === "$" || c === "`") {
        literal = false;
        text += HOLE;
        i = skipExpansion(src, i);
      } else {
        if (c === "*" || c === "?" || c === "[" || c === "{") literal = false;
        text += c;
        i++;
      }
    }
    return { text, literal };
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "\n") {
      finish("\n");
      i++;
      if (pending.length > 0) {
        const r = skipHeredocBodies(src, i, pending);
        pending.forEach((p, k) => {
          p.redirect.body = r.bodies[k] ?? "";
        });
        pending = [];
        i = r.end;
      }
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (cases.at(-1) === "pattern" && (c === "(" || c === "|" || c === ")")) {
      if (c === ")") cases[cases.length - 1] = "body";
      i++;
      continue;
    }
    if (inTest) {
      const n = src.startsWith("&&", i) || src.startsWith("||", i) ? 2 : c === "(" || c === ")" ? 1 : 0;
      if (n > 0) {
        i += n;
        continue;
      }
    }
    const arithmetic = src.startsWith("((", i) ? arithmeticEnd(src, i) : null;
    if (arithmetic !== null) {
      i = arithmetic;
      pushWord({ text: "", literal: false });
      continue;
    }
    if (!inTest) {
      if ((c === "<" || c === ">") && src[i + 1] === "(") {
        i = skipParens(src, i + 1);
        pushWord({ text: "", literal: false });
        continue;
      }
      const r = REDIRECT_RE.exec(src.slice(i, i + 16));
      if (r) {
        i += r[0].length;
        const redirect = { op: r[2], fd: r[1], target: null, body: null };
        cur.redirects.push(redirect);
        awaitingTarget = null;
        awaitingDelim = null;
        if (redirect.op === "<<" || redirect.op === "<<-") awaitingDelim = { redirect, strip: redirect.op === "<<-" };
        else awaitingTarget = redirect;
        continue;
      }
    }
    const op = OPERATOR_RE.exec(src.slice(i, i + 3));
    if (op) {
      finish(op[1]);
      i += op[1].length;
      if (op[1].startsWith(";;") || op[1] === ";&") {
        if (cases.at(-1) === "body") cases[cases.length - 1] = "pattern";
      }
      continue;
    }
    if (c === "(") {
      finish("(");
      items.push({ kind: "open", group: "paren" });
      i++;
      continue;
    }
    if (c === ")") {
      finish(")");
      items.push({ kind: "close", group: "paren", sep: "" });
      i++;
      continue;
    }
    pushWord(readWord());
  }
  finish("");
  return items;
}
var WRITE_OPS = /* @__PURE__ */ new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
var PREFIX_WORDS = /* @__PURE__ */ new Set([
  "!",
  "{",
  "}",
  "do",
  "done",
  "then",
  "else",
  "elif",
  "fi",
  "if",
  "while",
  "until",
  "esac",
  "exec",
  "command",
  "builtin",
  "nohup"
]);
var WRAPPERS = /* @__PURE__ */ new Map([
  ["time", /* @__PURE__ */ new Set()],
  ["npx", /* @__PURE__ */ new Set(["-p", "--package"])],
  ["env", /* @__PURE__ */ new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["sudo", /* @__PURE__ */ new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-D",
    "--chdir",
    "-h",
    "--host",
    "-r",
    "--role",
    "-t",
    "--type",
    "-U",
    "--other-user",
    "-T",
    "--command-timeout"
  ])]
]);
var MAX_PATH = 4096;
var ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
var PYTHON_RE = /^python(\d+(\.\d+)?)?$/;
var JS_RUNNERS = /* @__PURE__ */ new Set(["node", "tsx", "ts-node", "bun"]);
function resolvePath(path, dir) {
  const full = path.startsWith("/") ? path : dir === null ? null : dir + "/" + path;
  return full === null || full.length > MAX_PATH ? null : posix.normalize(full);
}
function place(path, dir) {
  if (path === "" || path === "-" || path.startsWith("/dev/")) return null;
  if (path.includes(HOLE) || path.includes("$") || path.includes("`")) return null;
  return resolvePath(path, dir);
}
var placeWord = (w, dir) => w.literal ? place(w.text, dir) : null;
function cdTarget(args, dir, home) {
  let k = 0;
  while (k < args.length && /^-[LPe@]+$/.test(args[k].text)) k++;
  if (args[k]?.text === "--") k++;
  const target = args[k];
  if (target === void 0) return home;
  if (target.text === "-" || !target.literal) return null;
  return resolvePath(target.text, dir);
}
function sedFiles(args) {
  let inPlace = false;
  let scriptGiven = false;
  const operands = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a].text;
    if (t === "--") {
      operands.push(...args.slice(a + 1));
      break;
    }
    if (t.startsWith("--")) {
      if (t === "--in-place" || t.startsWith("--in-place=")) inPlace = true;
      else if (t === "--expression" || t === "--file") {
        scriptGiven = true;
        a++;
      } else if (t.startsWith("--expression=") || t.startsWith("--file=")) scriptGiven = true;
      else if (t === "--line-length") a++;
      continue;
    }
    if (t.length > 1 && t.startsWith("-")) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c];
        if (ch === "i") {
          inPlace = true;
          const next = args[a + 1];
          if (c === t.length - 1 && next !== void 0 && (next.text === "" || /^\.[\w.-]*$/.test(next.text))) a++;
          break;
        }
        if (ch === "e" || ch === "f") {
          scriptGiven = true;
          if (c === t.length - 1) a++;
          break;
        }
        if (ch === "l") {
          if (c === t.length - 1) a++;
          break;
        }
      }
      continue;
    }
    operands.push(args[a]);
  }
  if (!inPlace) return [];
  return scriptGiven ? operands : operands.slice(1);
}
function perlFiles(args) {
  let inPlace = false;
  let codeGiven = false;
  const operands = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a].text;
    if (operands.length === 0 && t === "--") continue;
    if (operands.length === 0 && t.length > 1 && t.startsWith("-")) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c];
        if (ch === "e" || ch === "E") {
          codeGiven = true;
          if (c === t.length - 1) a++;
          break;
        }
        if (ch === "i") {
          inPlace = true;
          break;
        }
        if ("IMmFCx".includes(ch)) break;
        if (ch === "0" || ch === "l") while (/[0-7]/.test(t[c + 1] ?? "")) c++;
      }
      continue;
    }
    operands.push(args[a]);
  }
  if (!inPlace) return [];
  return codeGiven ? operands : operands.slice(1);
}
function interpreterRun(name, args) {
  const python = PYTHON_RE.test(name);
  const code = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a].text;
    if (python) {
      if (t === "-c") {
        code.push(args[a + 1]?.text ?? "");
        return { code, readsStdin: false, script: null };
      }
      if (t === "-m") return { code, readsStdin: false, script: null };
      if (t === "-X" || t === "-W") {
        a++;
        continue;
      }
    } else {
      if (t === "-e" || t === "--eval" || t === "-p" || t === "--print") {
        code.push(args[a + 1]?.text ?? "");
        a++;
        continue;
      }
      if (t.startsWith("--eval=")) {
        code.push(t.slice("--eval=".length));
        continue;
      }
      if (t === "-r" || t === "--require" || t === "--import" || t === "--loader" || t === "-C") {
        a++;
        continue;
      }
    }
    if (t === "-") return { code, readsStdin: true, script: null };
    if (t.startsWith("-")) continue;
    return { code, readsStdin: false, script: args[a] };
  }
  return { code, readsStdin: code.length === 0, script: null };
}
var STR = String.raw`'([^'\n]*)'|"([^"\n]*)"|` + "`([^`$]*)`";
var ARG = String.raw`\s*(?:(?:${STR})|([A-Za-z_]\w*)(?=\s*[,)]))`;
var WRITE_CALLS = [
  // open(p, 'w') and open(p, encoding=…, mode='a'); the mode is checked below.
  new RegExp(String.raw`\bopen\(${ARG}\s*,\s*(?:mode\s*=\s*)?(?:${STR})`, "g"),
  new RegExp(String.raw`\bopen\(${ARG}\s*,[^)]{0,300}?\bmode\s*=\s*(?:${STR})`, "g"),
  // Path(p) and pathlib.Path(p) alike: \b falls before the P in both.
  new RegExp(String.raw`\bPath\(${ARG}\s*\)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(${ARG}`, "g")
];
var WRITE_MODE_RE = /^[rwaxbt+]*[wax+][rwaxbt+]*$/;
var MAX_HEADER = 2e3;
var MAX_BLOCK = 2e4;
function literalOf(m, first) {
  return m[first] ?? m[first + 1] ?? m[first + 2];
}
function codeMask(body, lang) {
  const code = new Uint8Array(body.length).fill(1);
  let prev = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    const start = i;
    if (lang === "python" && c === "#" || lang === "js" && c === "/" && body[i + 1] === "/") {
      const e = body.indexOf("\n", i);
      i = e === -1 ? body.length : e;
    } else if (lang === "js" && c === "/" && body[i + 1] === "*") {
      const e = body.indexOf("*/", i + 2);
      i = e === -1 ? body.length : e + 2;
    } else if (lang === "js" && c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let inClass = false;
      i++;
      while (i < body.length && body[i] !== "\n") {
        const d = body[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        i++;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
      }
      prev = "/";
    } else if (c === "'" || c === '"' || lang === "js" && c === "`") {
      const close = lang === "python" && body.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += close.length;
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body.startsWith(close, i)) {
          i += close.length;
          break;
        }
        if (close.length === 1 && c !== "`" && body[i] === "\n") break;
        i++;
      }
      prev = c;
    } else {
      if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") prev = c;
      i++;
      continue;
    }
    code.fill(0, start, Math.min(i, body.length));
  }
  return code;
}
function blockOf(body, code, at, lang) {
  const none = { header: [at, at], block: [at, at] };
  const headerLimit = Math.min(body.length, at + MAX_HEADER);
  if (lang === "python") {
    let depth2 = 0;
    let colon = -1;
    for (let j2 = at; j2 < headerLimit; j2++) {
      if (code[j2] !== 1) continue;
      const ch = body[j2];
      if (ch === "(" || ch === "[" || ch === "{") depth2++;
      else if (ch === ")" || ch === "]" || ch === "}") depth2--;
      else if (ch === ":" && depth2 === 0) {
        colon = j2;
        break;
      }
    }
    if (colon === -1) return none;
    const nl = body.indexOf("\n", colon);
    const eol = nl === -1 ? body.length : nl;
    const rest = body.slice(colon + 1, eol).trim();
    if (rest !== "" && !rest.startsWith("#")) return { header: [at, colon], block: [colon + 1, eol] };
    const indentAt = (from) => {
      let k2 = from;
      while (body[k2] === " " || body[k2] === "	") k2++;
      return k2 - from;
    };
    const headerIndent = indentAt(body.lastIndexOf("\n", at) + 1);
    const blockLimit2 = Math.min(body.length, eol + MAX_BLOCK);
    let end = eol;
    let p = eol + 1;
    while (p < blockLimit2) {
      const n = body.indexOf("\n", p);
      const le = n === -1 ? body.length : n;
      if (body.slice(p, le).trim() !== "") {
        if (indentAt(p) <= headerIndent) break;
        end = le;
      }
      p = le + 1;
    }
    return { header: [at, colon], block: [eol + 1, end] };
  }
  let j = body.indexOf("(", at);
  if (j === -1 || j >= headerLimit) return none;
  let depth = 0;
  for (; j < headerLimit; j++) {
    if (code[j] !== 1) continue;
    if (body[j] === "(") depth++;
    else if (body[j] === ")" && --depth === 0) break;
  }
  if (j >= headerLimit) return none;
  const blockLimit = Math.min(body.length, j + MAX_BLOCK);
  let k = j + 1;
  while (k < blockLimit && /\s/.test(body[k])) k++;
  if (body[k] === "{") {
    let d = 0;
    for (let m2 = k; m2 < blockLimit; m2++) {
      if (code[m2] !== 1) continue;
      if (body[m2] === "{") d++;
      else if (body[m2] === "}" && --d === 0) return { header: [at, j], block: [k, m2 + 1] };
    }
    return { header: [at, j], block: [k, blockLimit] };
  }
  let m = k;
  while (m < blockLimit && !(code[m] === 1 && (body[m] === ";" || body[m] === "\n"))) m++;
  return { header: [at, j], block: [k, m] };
}
function scriptWrites(body, lang) {
  const code = codeMask(body, lang);
  const isCode = (at) => at !== void 0 && code[at] === 1;
  const vars = /* @__PURE__ */ new Map();
  const assign = new RegExp(
    String.raw`(?<![\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*(?:(?:pathlib\.)?Path\(\s*)?(?:${STR})`,
    "g"
  );
  for (const m of body.matchAll(assign)) if (isCode(m.index)) vars.set(m[1], literalOf(m, 2));
  const targets = [];
  const names = /* @__PURE__ */ new Map();
  const addName = (name, at) => {
    const list = names.get(name);
    if (list === void 0) names.set(name, [at]);
    else list.push(at);
  };
  WRITE_CALLS.forEach((re, k) => {
    for (const m of body.matchAll(re)) {
      if (!isCode(m.index)) continue;
      if (k === 3) {
        addName(m[1], m.index);
        continue;
      }
      if (k <= 1 && !WRITE_MODE_RE.test(literalOf(m, 5) ?? "")) continue;
      const lit = literalOf(m, 1);
      if (lit !== void 0) targets.push(lit);
      else if (m[4] !== void 0) addName(m[4], m.index);
    }
  });
  for (const [name, calls] of names) {
    const v = vars.get(name);
    if (v !== void 0) {
      targets.push(v);
      continue;
    }
    calls.sort((a, b) => a - b);
    const writesIn = ([start, end]) => {
      let lo = 0;
      let hi = calls.length;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (calls[mid] < start) lo = mid + 1;
        else hi = mid;
      }
      return lo < calls.length && calls[lo] < end;
    };
    const only = (found) => found.some((f) => writesIn(f.block)) ? found.filter((f) => writesIn(f.block)) : found;
    const defs = [];
    for (const d of body.matchAll(/\b(?:def|function)\s+(\w+)\s*\(\s*([A-Za-z_]\w*)/g)) {
      if (d[2] === name && isCode(d.index)) defs.push({ fn: d[1], block: blockOf(body, code, d.index, lang).block });
    }
    for (const { fn } of only(defs)) {
      for (const c of body.matchAll(new RegExp(String.raw`\b${fn}\(\s*(?:${STR})`, "g"))) {
        if (isCode(c.index)) targets.push(literalOf(c, 1));
      }
    }
    const loop = lang === "python" ? new RegExp(String.raw`\bfor\s+${name}\s+in\s+[[(]`, "g") : new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+${name}\s+of\s+\[`, "g");
    const loops = [];
    for (const f of body.matchAll(loop)) {
      if (!isCode(f.index)) continue;
      const { header, block } = blockOf(body, code, f.index, lang);
      loops.push({ list: body.slice(f.index + f[0].length - 1, header[1]), block });
    }
    for (const { list } of only(loops)) {
      for (const s of list.matchAll(new RegExp(STR, "g"))) targets.push(literalOf(s, 1));
    }
  }
  return targets;
}
function shellWrittenFiles(command, cwd, home) {
  const found = /* @__PURE__ */ new Set();
  const add = (p) => {
    if (p !== null) found.add(p);
  };
  const groups = [];
  const pushed = [];
  const writtenBodies = /* @__PURE__ */ new Map();
  let dir = cwd;
  let piped = null;
  let prevSep = "";
  let afterOr;
  const pipe = (sep) => sep === "|" || sep === "|&";
  const endBranch = (sep) => {
    if (afterOr !== void 0 && afterOr.depth === groups.length && sep !== "||" && !pipe(sep)) {
      dir = afterOr.dir;
      afterOr = void 0;
    }
  };
  for (const item of parse(command, home)) {
    if (item.kind === "open") {
      groups.push({ group: item.group, dir, piped: pipe(prevSep) });
      prevSep = "";
      continue;
    }
    if (item.kind === "close") {
      const g = groups.pop();
      if (g !== void 0) {
        const own = g.group === "brace" && !g.piped && !pipe(item.sep) && item.sep !== "&";
        if (!own) dir = g.dir;
        if (afterOr !== void 0 && afterOr.depth > groups.length) {
          if (own) afterOr.depth = groups.length;
          else afterOr = void 0;
        }
      }
      prevSep = item.sep;
      endBranch(item.sep);
      continue;
    }
    const { words, redirects, sep } = item.cmd;
    const ownShell = sep !== "&" && sep !== "|" && sep !== "|&" && prevSep !== "|" && prevSep !== "|&";
    prevSep = sep;
    let stdin = piped;
    piped = null;
    for (const r of redirects) {
      if (r.op === "<<" || r.op === "<<-") stdin = r.body;
      else if (r.op === "<<<") stdin = r.target?.text ?? null;
    }
    let stdoutToFile = false;
    for (const r of redirects) {
      if (!WRITE_OPS.has(r.op) || r.target === null) continue;
      if (r.op === ">&" && /^(\d+|-)$/.test(r.target.text)) continue;
      const p = placeWord(r.target, dir);
      add(p);
      if (r.fd === "" || r.fd === "1") stdoutToFile = true;
      if (p !== null && stdin !== null) writtenBodies.set(p, stdin);
    }
    let k = 0;
    while (k < words.length) {
      const t = words[k].text;
      if (PREFIX_WORDS.has(t) || ASSIGNMENT_RE.test(t)) {
        k++;
        continue;
      }
      const valued = WRAPPERS.get(t);
      if (valued !== void 0) {
        k++;
        while (k < words.length) {
          const o = words[k].text;
          if (o === "--") {
            k++;
            break;
          }
          if (t === "env" && ASSIGNMENT_RE.test(o)) {
            k++;
            continue;
          }
          if (!o.startsWith("-")) break;
          k += valued.has(o) ? 2 : 1;
        }
        continue;
      }
      break;
    }
    const name = words[k]?.text ?? "";
    const args = words.slice(k + 1);
    if (name === "cd" || name === "pushd" || name === "popd") {
      if (ownShell) {
        let next;
        if (name === "popd") next = pushed.length > 0 ? pushed.pop() : null;
        else {
          if (name === "pushd") pushed.push(dir);
          next = cdTarget(args, dir, home);
        }
        if (sep === "||") afterOr = { dir: next, depth: groups.length };
        else dir = next;
      }
    } else if (name === "tee") {
      let options = true;
      for (const a of args) {
        if (options && a.text === "--") {
          options = false;
          continue;
        }
        if (options && a.text.length > 1 && a.text.startsWith("-")) continue;
        add(placeWord(a, dir));
      }
    } else if (name === "sed") sedFiles(args).forEach((a) => add(placeWord(a, dir)));
    else if (name === "perl") perlFiles(args).forEach((a) => add(placeWord(a, dir)));
    else if (PYTHON_RE.test(name) || JS_RUNNERS.has(name)) {
      const run = interpreterRun(name, args);
      const scripts = [...run.code];
      if (run.readsStdin && stdin !== null) scripts.push(stdin);
      if (run.script !== null) {
        const p = placeWord(run.script, dir);
        const body = p === null ? void 0 : writtenBodies.get(p);
        if (body !== void 0) scripts.push(body);
      }
      const lang = PYTHON_RE.test(name) ? "python" : "js";
      for (const s of scripts) for (const t of scriptWrites(s, lang)) add(place(t, dir));
    } else if (name === "cat" && sep === "|" && !stdoutToFile && stdin !== null && args.length === 0) {
      piped = stdin;
    }
    endBranch(sep);
  }
  return [...found];
}

// src/indexer/claude_parser.ts
var TOOL_INPUT_BYTE_CAP = 2048;
var SHELL_TOOL_INPUT_BYTE_CAP = 65536;
var ASSISTANT_TEXT_BYTE_CAP = 65536;
var EVENT_UNKNOWN_BLOCK_CAP = 1024;
var SYSTEM_REMINDER_EXCERPT_CAP = 512;
var HOOK_REASON_BYTE_CAP = 512;
var SKILL_AGENT_ARG_CHAR_CAP = 256;
var FILE_OP_TOOLS = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "NotebookEdit"]);
var SLASH_COMMAND_RE = /<command-name>\s*\/?([a-zA-Z0-9_:.\-]+)\s*<\/command-name>/g;
var SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
var HOOK_ERROR_PREFIX_RE = /^(\w+):(\S+) hook error:/;
var REMINDER_TAXONOMY = [
  {
    category: "hook_success",
    match: (t) => /hook success/i.test(t) || /hook additional context/i.test(t)
  },
  {
    category: "task_reminder",
    match: (t) => /task tools haven't been used/i.test(t) || /consider using TaskCreate/i.test(t)
  },
  {
    category: "available_agents",
    match: (t) => /Available agent types for the Agent tool/i.test(t)
  },
  {
    category: "available_skills",
    match: (t) => /The following skills are available/i.test(t)
  },
  {
    category: "available_tools",
    match: (t) => /deferred tools are now available/i.test(t)
  },
  {
    category: "session_start",
    match: (t) => /SessionStart/i.test(t)
  },
  {
    category: "user_prompt_submit",
    match: (t) => /UserPromptSubmit/i.test(t)
  }
];
function codepointLength(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}
function utf8SafeTruncate(s, cap) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) return { out: s, truncated: false };
  let end = cap;
  while (end > 0 && (buf[end] & 192) === 128) end -= 1;
  return { out: buf.slice(0, end).toString("utf8"), truncated: true };
}
var TRUNCATE_MARKER = "\n\u2026[truncated]\u2026\n";
var ERROR_HEAD_CHARS = 100;
var ERROR_TAIL_CHARS = 200;
function errorExcerpt(text) {
  const t = text.trim();
  if (t === "") return null;
  if (codepointLength(t) <= ERROR_HEAD_CHARS + ERROR_TAIL_CHARS) return t;
  const head = [...t.slice(0, ERROR_HEAD_CHARS * 2)].slice(0, ERROR_HEAD_CHARS).join("");
  const tail = [...t.slice(-ERROR_TAIL_CHARS * 2)].slice(-ERROR_TAIL_CHARS).join("");
  return head + TRUNCATE_MARKER + tail;
}
function utf8SafeHeadTailTruncate(s, cap) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) return { out: s, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, "utf8");
  const keep = Math.max(cap - markerBytes, 0);
  const headCap = Math.ceil(keep / 2);
  const tailCap = keep - headCap;
  let headEnd = headCap;
  while (headEnd > 0 && (buf[headEnd] & 192) === 128) headEnd -= 1;
  let tailStart = buf.byteLength - tailCap;
  while (tailStart < buf.byteLength && (buf[tailStart] & 192) === 128) tailStart += 1;
  const head = buf.slice(0, headEnd).toString("utf8");
  const tail = buf.slice(tailStart).toString("utf8");
  return { out: head + TRUNCATE_MARKER + tail, truncated: true };
}
function bumpAnomaly(batch, kind, detail = null) {
  const cur = batch.counters.get(kind);
  if (cur) {
    cur.count += 1;
    if (detail !== null) cur.detail = detail;
  } else {
    batch.counters.set(kind, { count: 1, detail });
  }
}
function classifyReminder(text) {
  for (const c of REMINDER_TAXONOMY) if (c.match(text)) return c.category;
  return "other";
}
function isToolResultBlob(text) {
  return text.startsWith("[{") && text.includes("tool_use_id");
}
function stripCommandMarkup(text) {
  if (!/<command-(?:name|message|args)>/.test(text)) return text;
  return text.replace(/<command-(name|message)>[\s\S]*?<\/command-\1>/g, "").replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1").trim();
}
function isContinuationSummary(text) {
  const head = text.slice(0, 200);
  return /This session is being continued from a previous conversation/i.test(head);
}
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}
function walkContent(args) {
  const { event_uuid, session_id, ts, role, isMeta, cwd, gitBranch, content, batch, out, toolResults } = args;
  const summary = {
    has_text: 0,
    has_tool_use: 0,
    has_tool_res: 0,
    text_len: 0
  };
  if (content === null || content === void 0) {
    bumpAnomaly(batch, "null_content");
    return summary;
  }
  if (typeof content === "string") {
    summary.has_text = 1;
    summary.text_len += codepointLength(content);
    if (role === "user" && !isToolResultBlob(content)) {
      if (isMeta) {
        scanSlashCommands(content, event_uuid, session_id, ts, out.slash_commands);
        bumpAnomaly(batch, "skill_body_skipped");
      } else {
        const userText = {
          event_uuid,
          session_id,
          ts,
          text: stripCommandMarkup(content),
          is_command: scanSlashCommands(content, event_uuid, session_id, ts, out.slash_commands) ? 1 : 0,
          role: "user",
          type: isContinuationSummary(content) ? "continuation_summary" : "user_message"
        };
        out.user_texts.push(userText);
      }
    }
    extractRemindersFromText(content, event_uuid, session_id, ts, out.system_reminders);
    return summary;
  }
  if (!Array.isArray(content)) {
    bumpAnomaly(batch, "unrecognized_content_shape");
    return summary;
  }
  let blockIndex = 0;
  const userTextChunks = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      const raw = JSON.stringify(block);
      const truncRaw = raw.slice(0, EVENT_UNKNOWN_BLOCK_CAP);
      out.unknown_blocks.push({
        event_uuid,
        session_id,
        block_index: blockIndex,
        raw_json: truncRaw
      });
      bumpAnomaly(batch, "unknown_block_type");
      blockIndex += 1;
      continue;
    }
    const b = block;
    const t = typeof b.type === "string" ? b.type : "<missing>";
    if (t === "text" && typeof b.text === "string") {
      summary.has_text = 1;
      summary.text_len += codepointLength(b.text);
      if (role === "user" && !isToolResultBlob(b.text)) {
        userTextChunks.push(b.text);
      } else if (role === "assistant" && b.text.length > 0) {
        const { out: clipped } = utf8SafeHeadTailTruncate(b.text, ASSISTANT_TEXT_BYTE_CAP);
        out.user_texts.push({
          event_uuid,
          session_id,
          ts,
          text: clipped,
          is_command: 0,
          role: "assistant",
          type: "assistant_message"
        });
      }
      extractRemindersFromText(b.text, event_uuid, session_id, ts, out.system_reminders);
    } else if (t === "tool_use") {
      summary.has_tool_use = 1;
      const name = typeof b.name === "string" ? b.name : "<missing>";
      const call_id = typeof b.id === "string" ? b.id : null;
      const inputRaw = b.input === void 0 ? null : JSON.stringify(b.input);
      let input_json = null;
      if (inputRaw !== null) {
        const cap = name === "Bash" ? SHELL_TOOL_INPUT_BYTE_CAP : TOOL_INPUT_BYTE_CAP;
        const { out: clipped, truncated } = utf8SafeTruncate(inputRaw, cap);
        input_json = clipped;
        if (truncated) bumpAnomaly(batch, "tool_input_truncated");
      }
      const toolCall = {
        event_uuid,
        session_id,
        ts,
        call_id,
        name,
        input_json,
        duration_ms: null,
        is_error: 0,
        result_chars: null,
        git_branch: gitBranch
      };
      out.tool_calls.push(toolCall);
      if (FILE_OP_TOOLS.has(name)) {
        const input = b.input ?? {};
        const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
        if (path !== null) {
          out.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
        }
      }
      if (name === "Bash") {
        const command = b.input?.command;
        if (typeof command === "string") {
          let paths = [];
          try {
            paths = shellWrittenFiles(command, cwd, homedir());
          } catch {
            bumpAnomaly(batch, "shell_writes_error");
          }
          for (const path of paths) {
            out.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
          }
        }
      }
      if (name === "Skill") {
        const input = b.input ?? {};
        const skill = typeof input.skill === "string" ? input.skill : "<missing>";
        const argsStr = typeof input.args === "string" ? input.args : input.args === void 0 ? "" : JSON.stringify(input.args);
        const args_excerpt = argsStr.slice(0, SKILL_AGENT_ARG_CHAR_CAP);
        const row = {
          event_uuid,
          session_id,
          ts,
          skill,
          args_excerpt
        };
        out.skill_calls.push(row);
      }
      if (name === "Agent") {
        const input = b.input ?? {};
        const subagent_type = typeof input.subagent_type === "string" ? input.subagent_type : "<default>";
        const description = typeof input.description === "string" ? input.description : null;
        const promptStr = typeof input.prompt === "string" ? input.prompt : "";
        const row = {
          event_uuid,
          session_id,
          ts,
          subagent_type,
          description,
          prompt_excerpt: promptStr.slice(0, SKILL_AGENT_ARG_CHAR_CAP)
        };
        out.agent_calls.push(row);
      }
    } else if (t === "tool_result") {
      summary.has_tool_res = 1;
      const tool_use_id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
      const is_error = b.is_error === true ? 1 : 0;
      if (tool_use_id !== null) {
        const text = toolResultText(b.content);
        toolResults.set(tool_use_id, {
          ts,
          is_error,
          result_chars: codepointLength(text),
          error_excerpt: is_error === 1 ? errorExcerpt(text) : null
        });
        const m = is_error === 1 ? HOOK_ERROR_PREFIX_RE.exec(text) : null;
        if (m !== null) {
          const rest = text.slice(m[0].length).trim();
          out.hook_blocks.push({
            event_uuid,
            session_id,
            ts,
            hook_event: m[1],
            tool: m[2],
            call_id: tool_use_id,
            reason: rest === "" ? null : utf8SafeTruncate(rest, HOOK_REASON_BYTE_CAP).out
          });
        }
      }
    } else if (t === "thinking") {
    } else {
      const raw = JSON.stringify(block).slice(0, EVENT_UNKNOWN_BLOCK_CAP);
      out.unknown_blocks.push({
        event_uuid,
        session_id,
        block_index: blockIndex,
        raw_json: raw
      });
      bumpAnomaly(batch, "unknown_block_type");
    }
    blockIndex += 1;
  }
  if (userTextChunks.length > 0) {
    const joined = userTextChunks.join("\n");
    if (isMeta) {
      bumpAnomaly(batch, "skill_body_skipped");
    } else {
      const isCommand = scanSlashCommands(
        joined,
        event_uuid,
        session_id,
        ts,
        out.slash_commands
      );
      out.user_texts.push({
        event_uuid,
        session_id,
        ts,
        text: stripCommandMarkup(joined),
        is_command: isCommand ? 1 : 0,
        role: "user",
        type: isContinuationSummary(joined) ? "continuation_summary" : "user_message"
      });
    }
  }
  return summary;
}
function scanSlashCommands(text, event_uuid, session_id, ts, out) {
  let hit = false;
  SLASH_COMMAND_RE.lastIndex = 0;
  let m;
  while ((m = SLASH_COMMAND_RE.exec(text)) !== null) {
    hit = true;
    out.push({
      event_uuid,
      session_id,
      ts,
      name: m[1]
    });
  }
  return hit;
}
function extractRemindersFromText(text, event_uuid, session_id, ts, out) {
  SYSTEM_REMINDER_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = SYSTEM_REMINDER_BLOCK_RE.exec(text)) !== null) {
    const body = m[1].replace(/\s+/g, " ").trim();
    const cat = classifyReminder(body);
    out.push({
      event_uuid,
      session_id,
      ts,
      category: cat,
      text_excerpt: utf8SafeTruncate(body, SYSTEM_REMINDER_EXCERPT_CAP).out
    });
  }
}
var SUBAGENT_FILE_RE = /[\\/]subagents[\\/](?:[^\\/]+[\\/])*agent-[^\\/]+\.jsonl$/;
function agentSessionId(agentId) {
  return `agent-${agentId}`;
}
function parseEventLine(line, source_file, seq, batch, toolResults) {
  if (line.length === 0) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    bumpAnomaly(batch, "json_parse_error", JSON.stringify({ source_file, seq }));
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    bumpAnomaly(batch, "non_object_line");
    return null;
  }
  const o = obj;
  if (typeof o.uuid !== "string") {
    bumpAnomaly(batch, "non_event_line");
    return null;
  }
  const uuid = o.uuid;
  const session_id = o.isSidechain === true && typeof o.agentId === "string" ? agentSessionId(o.agentId) : typeof o.sessionId === "string" ? o.sessionId : "<unknown>";
  if (batch.session_id === null) batch.session_id = session_id;
  const ts = typeof o.timestamp === "string" ? o.timestamp : (/* @__PURE__ */ new Date(0)).toISOString();
  const role = typeof o.type === "string" ? o.type : null;
  const message = o.message ?? {};
  const usage2 = message.usage ?? {};
  const messageRole = typeof message.role === "string" ? message.role : null;
  if (role !== null && messageRole !== null && messageRole !== role && role !== "attachment") {
    bumpAnomaly(batch, "role_mismatch");
  }
  const event = {
    uuid,
    session_id,
    parent_uuid: typeof o.parentUuid === "string" ? o.parentUuid : null,
    prompt_id: typeof o.promptId === "string" ? o.promptId : null,
    agent_id: typeof o.agentId === "string" ? o.agentId : null,
    is_sidechain: typeof o.isSidechain === "boolean" ? o.isSidechain ? 1 : 0 : null,
    ts,
    role,
    model: typeof message.model === "string" ? message.model : null,
    in_tok: typeof usage2.input_tokens === "number" ? usage2.input_tokens : 0,
    out_tok: typeof usage2.output_tokens === "number" ? usage2.output_tokens : 0,
    cache_r: typeof usage2.cache_read_input_tokens === "number" ? usage2.cache_read_input_tokens : 0,
    cache_w: typeof usage2.cache_creation_input_tokens === "number" ? usage2.cache_creation_input_tokens : 0,
    text_len: 0,
    has_tool_use: 0,
    has_text: 0,
    has_tool_res: 0,
    user_turn_no: null,
    assistant_turn_no: null,
    source_file
  };
  const parsed = {
    event,
    tool_calls: [],
    file_ops: [],
    user_texts: [],
    skill_calls: [],
    agent_calls: [],
    slash_commands: [],
    system_reminders: [],
    hook_blocks: [],
    unknown_blocks: []
  };
  const summary = walkContent({
    event_uuid: uuid,
    session_id,
    ts,
    role: role ?? "",
    isMeta: o.isMeta === true,
    cwd: typeof o.cwd === "string" ? o.cwd : null,
    gitBranch: typeof o.gitBranch === "string" && o.gitBranch !== "" ? o.gitBranch : null,
    content: message.content,
    batch,
    out: parsed,
    toolResults
  });
  parsed.event.text_len = summary.text_len;
  parsed.event.has_text = summary.has_text;
  parsed.event.has_tool_use = summary.has_tool_use;
  parsed.event.has_tool_res = summary.has_tool_res;
  const attachment = o.attachment;
  if (o.type === "attachment" && attachment !== null && typeof attachment === "object") {
    const a = attachment;
    if (a.type === "hook_blocking_error" && typeof a.hookEvent === "string" && a.hookEvent !== "PreToolUse") {
      const blocking = a.blockingError;
      const reason = blocking !== null && typeof blocking === "object" ? blocking.blockingError : void 0;
      parsed.hook_blocks.push({
        event_uuid: uuid,
        session_id,
        ts,
        hook_event: a.hookEvent,
        tool: null,
        call_id: null,
        reason: typeof reason === "string" ? utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out : null
      });
    }
    const origin = a.origin;
    if (a.type === "queued_command" && origin?.kind === "human") {
      const text = toolResultText(a.prompt).trim();
      if (text !== "") {
        parsed.user_texts.push({ event_uuid: uuid, session_id, ts, text, is_command: 0, role: "user", type: "user_message" });
      }
    }
  }
  if (o.type === "system" && o.subtype === "compact_boundary") {
    const meta = o.compactMetadata;
    const trigger = meta !== null && typeof meta === "object" ? meta.trigger : void 0;
    parsed.system_reminders.push({
      event_uuid: uuid,
      session_id,
      ts,
      category: "compaction",
      text_excerpt: typeof trigger === "string" ? trigger : null
    });
  }
  return parsed;
}
function parseFileBody(args) {
  const { body, source_file, batch } = args;
  const events = [];
  const toolResults = /* @__PURE__ */ new Map();
  const sessionMeta = {
    cwd: null,
    git_branch: null,
    version: null
  };
  let entrypoint = null;
  const buf = Buffer.from(body, "utf8");
  let i = 0;
  let lineStartByte = 0;
  let lineSeq = 0;
  let lastOk = 0;
  let fullyTerminated = 0;
  while (i < buf.byteLength) {
    if (buf[i] === 10) {
      const line = buf.slice(lineStartByte, i).toString("utf8");
      lineSeq += 1;
      const parsed = parseEventLine(line, source_file, lineSeq, batch, toolResults);
      if (parsed !== null) events.push(parsed);
      if (sessionMeta.parent_id === void 0 && parsed !== null && parsed.event.agent_id !== null && parsed.event.session_id === agentSessionId(parsed.event.agent_id)) {
        const sid = JSON.parse(line).sessionId;
        if (typeof sid === "string") sessionMeta.parent_id = sid;
      }
      if (sessionMeta.cwd === null || sessionMeta.git_branch === null || sessionMeta.version === null || entrypoint === null) {
        try {
          const obj = JSON.parse(line);
          if (sessionMeta.cwd === null && typeof obj.cwd === "string") sessionMeta.cwd = obj.cwd;
          if (sessionMeta.git_branch === null && typeof obj.gitBranch === "string") sessionMeta.git_branch = obj.gitBranch;
          if (sessionMeta.version === null && typeof obj.version === "string") sessionMeta.version = obj.version;
          if (entrypoint === null && typeof obj.entrypoint === "string") entrypoint = obj.entrypoint;
        } catch {
        }
      }
      fullyTerminated += 1;
      lastOk = i + 1;
      lineStartByte = i + 1;
    }
    i += 1;
  }
  if (entrypoint?.startsWith("sdk-")) sessionMeta.kind = "exec";
  return {
    events,
    anomalies: batch,
    fully_terminated_line_count: fullyTerminated,
    last_ok_byte_offset: lastOk,
    tool_results: toolResults,
    session_meta: sessionMeta
  };
}
function assignTurnNumbers(events) {
  const sorted = [...events].sort((a2, b) => a2.event.ts < b.event.ts ? -1 : a2.event.ts > b.event.ts ? 1 : 0);
  let u = 0;
  let a = 0;
  for (const ev of sorted) {
    const e = ev.event;
    if (e.role === "user") {
      const isPseudo = e.has_text === 0 && e.has_tool_use === 0 && e.has_tool_res === 1;
      if (!isPseudo) {
        u += 1;
        e.user_turn_no = u;
      }
    } else if (e.role === "assistant") {
      a += 1;
      e.assistant_turn_no = a;
    }
  }
  return { userTurns: u, assistantTurns: a };
}

// src/indexer/cursor.ts
import { readdirSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/util/paths.ts
import { homedir as homedir2 } from "node:os";
import { join } from "node:path";
function claudeHome() {
  return process.env.CLENS_HOME ?? join(homedir2(), ".claude");
}
function clensHome() {
  if (process.env.CLENS_HOME !== void 0 && process.env.CLENS_INDEX_DIR === void 0) {
    return join(process.env.CLENS_HOME, "__no_clens__");
  }
  return process.env.CLENS_INDEX_DIR ?? join(homedir2(), ".clens");
}
function projectsDir() {
  return join(claudeHome(), "projects");
}
function codexHome() {
  if (process.env.CLENS_HOME !== void 0 && process.env.CLENS_CODEX_HOME === void 0) {
    return join(process.env.CLENS_HOME, "__no_codex__");
  }
  return process.env.CLENS_CODEX_HOME ?? join(homedir2(), ".codex");
}
function codexSessionsDir() {
  return join(codexHome(), "sessions");
}
function indexDbPath() {
  return join(clensHome(), "index.db");
}
function indexLockPath() {
  return join(clensHome(), "index.db.lock");
}
function modelsDir() {
  return join(clensHome(), "models");
}
function languageModelDir(code) {
  return join(modelsDir(), code);
}
function judgeCwdDir() {
  return join(clensHome(), "judge-cwd");
}

// src/util/project_id.ts
var MAX_NAME = 200;
function projectIdOf(path) {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return name;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h << 5) - h + path.charCodeAt(i) | 0;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(h).toString(36)}`;
}

// src/indexer/codex_parser.ts
import { homedir as homedir3 } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/util/codex_exec.ts
var CALL_RE = /tools\s*\.\s*exec_command\s*\(\s*\{/y;
var KEY_RE = /[A-Za-z_$][\w$]*/y;
var WORD_CHAR_RE = /[\w$.]/;
function execCodeScan(code) {
  const out = [];
  let built = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
    } else if (c === "t" && (i === 0 || !WORD_CHAR_RE.test(code[i - 1]))) {
      CALL_RE.lastIndex = i;
      const m = CALL_RE.exec(code);
      if (m === null) {
        i += 1;
        continue;
      }
      const obj = readObject(code, i + m[0].length);
      if (obj.closed && obj.cmd !== null) out.push({ cmd: obj.cmd, workdir: obj.workdir });
      else if (obj.closed) built += 1;
      i = obj.end;
    } else {
      i += 1;
    }
  }
  return { commands: out, built };
}
function skipNonCode(code, i) {
  const c = code[i];
  if (c === "/" && code[i + 1] === "/") {
    const end = code.indexOf("\n", i);
    return end === -1 ? code.length : end + 1;
  }
  if (c === "/" && code[i + 1] === "*") {
    const end = code.indexOf("*/", i + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (c === '"' || c === "'") return readQuoted(code, i)?.end ?? code.length;
  if (c === "`") return readTemplate(code, i)?.end ?? code.length;
  return i;
}
function skipSpace(code, i) {
  for (; ; ) {
    while (i < code.length && /\s/.test(code[i])) i += 1;
    if (code[i] === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) i = skipNonCode(code, i);
    else return i;
  }
}
function readObject(code, start) {
  let cmd = null;
  let workdir = null;
  let i = start;
  for (; ; ) {
    i = skipSpace(code, i);
    if (i >= code.length) return { cmd, workdir, end: code.length, closed: false };
    if (code[i] === "}") return { cmd, workdir, end: i + 1, closed: true };
    if (code[i] === ",") {
      i += 1;
      continue;
    }
    let key = null;
    if (code[i] === '"' || code[i] === "'") {
      const s = readQuoted(code, i);
      if (s === null) return { cmd, workdir, end: code.length, closed: false };
      key = s.value;
      i = s.end;
    } else {
      KEY_RE.lastIndex = i;
      const m = KEY_RE.exec(code);
      if (m !== null) {
        key = m[0];
        i += m[0].length;
      }
    }
    i = skipSpace(code, i);
    if (code[i] !== ":") {
      i = skipValue(code, i);
      if (code[i] !== "," && code[i] !== "}") return { cmd, workdir, end: i, closed: false };
      continue;
    }
    i = skipSpace(code, i + 1);
    const lit = code[i] === '"' || code[i] === "'" ? readQuoted(code, i) : code[i] === "`" ? readTemplate(code, i) : void 0;
    if (lit === null) return { cmd, workdir, end: code.length, closed: false };
    if (lit !== void 0) {
      const after = skipSpace(code, lit.end);
      if (lit.value !== null && (code[after] === "," || code[after] === "}")) {
        if (key === "cmd") cmd = lit.value;
        else if (key === "workdir") workdir = lit.value;
        i = after;
        continue;
      }
    }
    i = skipValue(code, i);
    if (code[i] !== "," && code[i] !== "}") return { cmd, workdir, end: i, closed: false };
  }
}
function skipValue(code, i) {
  let depth = 0;
  while (i < code.length) {
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === "," && depth === 0) return i;
    i += 1;
  }
  return code.length;
}
function readQuoted(code, i) {
  const quote = code[i];
  let value = "";
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === quote) return { value, end: j + 1 };
    if (c === "\\") {
      const e = unescape(code, j);
      value += e.text;
      j = e.end;
    } else {
      value += c;
      j += 1;
    }
  }
  return null;
}
function readTemplate(code, i) {
  let value = "";
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === "`") return { value, end: j + 1 };
    if (c === "\\") {
      const e = unescape(code, j);
      if (value !== null) value += e.text;
      j = e.end;
    } else if (c === "$" && code[j + 1] === "{") {
      value = null;
      j = skipPlaceholder(code, j + 2);
    } else {
      if (value !== null) value += c;
      j += 1;
    }
  }
  return null;
}
function skipPlaceholder(code, i) {
  let depth = 0;
  while (i < code.length) {
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = code[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
    i += 1;
  }
  return code.length;
}
function unescape(code, i) {
  const n = code[i + 1];
  if (n === void 0) return { text: "", end: i + 1 };
  const simple = { n: "\n", t: "	", r: "\r", b: "\b", f: "\f", v: "\v" };
  if (n in simple) return { text: simple[n], end: i + 2 };
  if (n === "0" && !/[0-9]/.test(code[i + 2] ?? "")) return { text: "\0", end: i + 2 };
  if (n === "x") {
    const hex = code.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 4 };
  }
  if (n === "u") {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(code.slice(i + 2, i + 10));
    if (braced !== null) {
      const cp = parseInt(braced[1], 16);
      if (cp <= 1114111) return { text: String.fromCodePoint(cp), end: i + 2 + braced[0].length };
    }
    const hex = code.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 6 };
  }
  if (n === "\r" && code[i + 2] === "\n") return { text: "", end: i + 3 };
  if (n === "\n" || n === "\r" || n === "\u2028" || n === "\u2029") return { text: "", end: i + 2 };
  return { text: n, end: i + 2 };
}

// src/indexer/codex_parser.ts
var TOOL_INPUT_BYTE_CAP2 = 2048;
var FILE_OP_TOOLS2 = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "NotebookEdit"]);
var SKILL_MARKER_RE = /\$([A-Za-z][\w-]*)/g;
function extractSkillCandidates(text) {
  const names = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(SKILL_MARKER_RE)) names.add(m[1]);
  return [...names];
}
function bumpAnomaly2(batch, kind) {
  const cur = batch.counters.get(kind);
  if (cur) cur.count += 1;
  else batch.counters.set(kind, { count: 1, detail: null });
}
function syntheticUuid(source_file, seq) {
  return `codex:${source_file}:${seq}`;
}
var SHELL_TOOLS = /* @__PURE__ */ new Set(["exec_command", "exec"]);
function truncateToolInput(raw, batch, cap = TOOL_INPUT_BYTE_CAP2) {
  const { out, truncated } = utf8SafeTruncate(raw, cap);
  if (truncated) bumpAnomaly2(batch, "tool_input_truncated");
  return out;
}
var PATCH_FILE_RE = /\*\*\* (?:Update File|Add File|Delete File|Move to): ([^\n\r\\"'`]+)/g;
function patchedFiles(input, cwd) {
  const out = /* @__PURE__ */ new Set();
  for (const m of input.matchAll(PATCH_FILE_RE)) {
    const p = m[1].trim();
    if (p !== "") out.add(isAbsolute(p) || cwd === null ? p : resolve(cwd, p));
  }
  return [...out];
}
function parseObjectLike(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
function codexOutputText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const part of output) {
    if (part === null || typeof part !== "object") continue;
    const p = part;
    if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") text += p.text;
  }
  return text;
}
var FAILED_OUTPUT_PREFIXES = [
  "Command blocked by PreToolUse hook: ",
  "Tool call blocked by PreToolUse hook: ",
  "aborted by user",
  "patch rejected by user",
  "exec_command failed",
  "write_stdin failed",
  "apply_patch verification failed",
  "Script failed"
];
function headerExitCode(text) {
  const outputAt = text.indexOf("\nOutput:");
  if (outputAt === -1) return null;
  const m = /Process exited with code (-?\d+)/.exec(text.slice(0, outputAt));
  return m === null ? null : Number(m[1]);
}
function headerRunningSession(text) {
  const outputAt = text.indexOf("\nOutput:");
  if (outputAt === -1) return null;
  const m = /Process running with session ID (\d+)/.exec(text.slice(0, outputAt));
  return m === null ? null : Number(m[1]);
}
var CODE_MODE_HEADER = /^Script (completed|failed|running with cell ID (\S+))\n/;
function codeModeOutput(output) {
  const parts = Array.isArray(output) ? output.map((part) => codexOutputText([part])) : [codexOutputText(output)];
  const header = CODE_MODE_HEADER.exec(parts[0] ?? "");
  if (header === null) return null;
  const outputAt = parts[0].indexOf("\nOutput:\n");
  const rest = outputAt === -1 ? [] : [parts[0].slice(outputAt + "\nOutput:\n".length), ...parts.slice(1)];
  const all = [];
  const failing = [];
  for (const part of rest) {
    if (part.trim() === "") continue;
    if (part.startsWith("Script error:")) {
      const error = part.slice("Script error:".length).replace(/^\n/, "");
      all.push(error);
      failing.push(error);
      continue;
    }
    const results = commandResults(part);
    if (results.length === 0) {
      all.push(part);
      continue;
    }
    for (const result of results) {
      const text = result.exit !== null && result.exit !== 0 ? `Process exited with code ${result.exit}
${result.output}` : result.output;
      all.push(text);
      if (result.exit !== null && result.exit !== 0) failing.push(text);
    }
  }
  return {
    runningCell: header[2] ?? null,
    failed: header[1] === "failed" || failing.length > 0,
    failingText: failing.length > 0 ? failing.join("\n") : null,
    printedText: all.join("\n")
  };
}
function commandResults(part) {
  const trimmed = part.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const found = [];
  const walk = (value, depth) => {
    if (value === null || typeof value !== "object" || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value;
    if (typeof record.chunk_id === "string" && typeof record.output === "string") {
      found.push({ exit: typeof record.exit_code === "number" ? record.exit_code : null, output: record.output });
      return;
    }
    for (const item of Object.values(record)) walk(item, depth + 1);
  };
  walk(parsed, 0);
  return found;
}
function failedOutputText(text) {
  const outputAt = text.indexOf("\nOutput:");
  if (outputAt === -1) return text;
  const header = text.slice(0, outputAt).split("\n");
  if (!header.some((line) => line.startsWith("Wall time:"))) return text;
  const exit = header.filter((line) => /^(?:Process exited with code|Exit code:)/.test(line));
  return [...exit, text.slice(outputAt + "\nOutput:".length).replace(/^\n/, "")].join("\n");
}
function ownFailure(text) {
  return FAILED_OUTPUT_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 1 : 0;
}
function codexOutputError(text) {
  if (ownFailure(text) === 1) return 1;
  const exit = /^Exit code: (-?\d+)/.exec(text);
  if (exit !== null && Number(exit[1]) !== 0) return 1;
  const headerExit = headerExitCode(text);
  if (headerExit !== null && headerExit !== 0) return 1;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const code = parsed?.metadata?.exit_code;
      if (typeof code === "number" && code !== 0) return 1;
    } catch {
    }
  }
  return 0;
}
var PRE_TOOL_USE_BLOCKS = [
  ["Command blocked by PreToolUse hook: ", ". Command: "],
  ["Tool call blocked by PreToolUse hook: ", ". Tool: "]
];
function preToolUseReason(text) {
  for (const [prefix, tail] of PRE_TOOL_USE_BLOCKS) {
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length);
    const end = rest.lastIndexOf(tail);
    const reason = (end === -1 ? rest : rest.slice(0, end)).trim();
    return reason === "" ? null : utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out;
  }
  return void 0;
}
function hookEventOf(runId) {
  const colon = runId.indexOf(":");
  if (colon <= 0) return null;
  return runId.slice(0, colon).split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}
function shellCommandFiles(cmd, workdir, batch) {
  try {
    return shellWrittenFiles(cmd, workdir, homedir3());
  } catch {
    bumpAnomaly2(batch, "shell_writes_error");
    return [];
  }
}
function detectToolError(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return 0;
  const record = result;
  if (typeof record.Err === "string") return 1;
  if (record.isError === true) return 1;
  const ok = record.Ok;
  if (ok && typeof ok === "object" && !Array.isArray(ok)) {
    return ok.isError === true ? 1 : 0;
  }
  return 0;
}
function addDerivedToolRows(args) {
  const { event_uuid, session_id, ts, name, parsed, input } = args;
  if (input === null) return;
  if (FILE_OP_TOOLS2.has(name)) {
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    if (path !== null) {
      parsed.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
    }
  }
  if (name === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill : "<missing>";
    const argsStr = typeof input.args === "string" ? input.args : JSON.stringify(input.args ?? "");
    parsed.skill_calls.push({
      event_uuid,
      session_id,
      ts,
      skill,
      args_excerpt: argsStr.slice(0, 256)
    });
  }
  if (name === "Agent") {
    const subagent_type = typeof input.subagent_type === "string" ? input.subagent_type : "<default>";
    const description = typeof input.description === "string" ? input.description : null;
    const promptStr = typeof input.prompt === "string" ? input.prompt : "";
    parsed.agent_calls.push({
      event_uuid,
      session_id,
      ts,
      subagent_type,
      description,
      prompt_excerpt: promptStr.slice(0, 256)
    });
  }
}
function compactJsonStream(text) {
  const out = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}") {
      if (--depth === 0) {
        try {
          out.push(JSON.stringify(JSON.parse(text.slice(start, i + 1))));
        } catch {
          return null;
        }
      }
    }
  }
  return depth === 0 && out.length > 0 ? out.join("\n") + "\n" : null;
}
function parseLine(line) {
  if (line.length === 0) return null;
  try {
    const obj = JSON.parse(line);
    if (typeof obj.type !== "string" || typeof obj.payload !== "object" || obj.payload === null || Array.isArray(obj.payload)) {
      return null;
    }
    return {
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : (/* @__PURE__ */ new Date(0)).toISOString(),
      type: obj.type,
      payload: obj.payload,
      ordinal: typeof obj.ordinal === "number" ? obj.ordinal : null
    };
  } catch {
    return null;
  }
}
function inCopiedHistory(cl, state) {
  if (state.historyStart === null || cl.ordinal === null || cl.ordinal >= state.historyStart) return false;
  if (cl.type === "session_meta" && cl.payload.id !== state.session_id) state.inParentCopy = true;
  return state.inParentCopy;
}
function uuidV7Ms(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) return null;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
function inParentTurn(cl, state) {
  if (state.kind !== "subagent" || state.createdMs === null) return false;
  const turn = uuidV7Ms(cl.payload.turn_id);
  if (turn !== null) state.inParentTurn = turn < state.createdMs;
  return state.inParentTurn;
}
function makeBlankEvent(uuid, session_id, ts, source_file) {
  return {
    uuid,
    session_id,
    parent_uuid: null,
    prompt_id: null,
    agent_id: null,
    is_sidechain: null,
    ts,
    role: null,
    model: null,
    in_tok: 0,
    out_tok: 0,
    cache_r: 0,
    cache_w: 0,
    text_len: 0,
    has_tool_use: 0,
    has_text: 0,
    has_tool_res: 0,
    user_turn_no: null,
    assistant_turn_no: null,
    source_file
  };
}
function makeBlankParsed(event) {
  return {
    event,
    tool_calls: [],
    file_ops: [],
    user_texts: [],
    skill_calls: [],
    agent_calls: [],
    slash_commands: [],
    system_reminders: [],
    hook_blocks: [],
    unknown_blocks: []
  };
}
function parseCodexFileBody(args) {
  return parseCodexFile(args).result;
}
function parseCodexFile(args) {
  const { source_file, batch } = args;
  const pretty = /^\{[ \t\r]*\n/.test(args.body);
  const body = pretty ? compactJsonStream(args.body) ?? args.body : args.body;
  const events = [];
  const state = {
    session_id: null,
    cwd: null,
    git_branch: null,
    version: null,
    model: null,
    pendingInTok: 0,
    pendingCachedTok: 0,
    pendingOutTok: 0,
    pendingTok: false,
    callEvents: /* @__PURE__ */ new Map(),
    openExec: /* @__PURE__ */ new Map(),
    failedExec: /* @__PURE__ */ new Map(),
    runningProcess: /* @__PURE__ */ new Map(),
    stdinTarget: /* @__PURE__ */ new Map(),
    runningCell: /* @__PURE__ */ new Map(),
    waitTarget: /* @__PURE__ */ new Map(),
    openDirect: /* @__PURE__ */ new Map(),
    namedCommands: /* @__PURE__ */ new Set(),
    historyStart: null,
    inParentCopy: false,
    createdMs: null,
    inParentTurn: false,
    kind: null,
    parentId: null
  };
  const resume = { state, toolResults: /* @__PURE__ */ new Map() };
  const { terminated, last_ok } = parseCodexLines({
    buf: Buffer.from(body, "utf8"),
    start: 0,
    first_seq: 1,
    source_file,
    resume,
    batch,
    events
  });
  return {
    result: {
      events,
      anomalies: batch,
      fully_terminated_line_count: terminated,
      last_ok_byte_offset: last_ok,
      tool_results: resume.toolResults,
      session_meta: {
        cwd: state.cwd,
        git_branch: state.git_branch,
        version: state.version,
        kind: state.kind ?? void 0,
        parent_id: state.parentId ?? void 0
      }
    },
    resume: pretty ? null : resume
  };
}
function parseCodexLines(args) {
  const { buf, source_file, batch, events } = args;
  const { state, toolResults } = args.resume;
  let lineStartByte = args.start;
  let lineSeq = args.first_seq - 1;
  let lastOk = args.start;
  let fullyTerminated = 0;
  for (let i = args.start; i < buf.byteLength; i++) {
    if (buf[i] !== 10) continue;
    const line = buf.subarray(lineStartByte, i).toString("utf8");
    lineSeq += 1;
    const cl = parseLine(line);
    if (cl === null) {
      if (line.trim().length > 0) bumpAnomaly2(batch, "json_parse_error");
    } else if (inCopiedHistory(cl, state) || inParentTurn(cl, state)) {
      bumpAnomaly2(batch, "copied_session_line_skipped");
    } else {
      processLine(cl, lineSeq, source_file, state, events, toolResults, batch);
      if (batch.session_id === null && state.session_id !== null) {
        batch.session_id = state.session_id;
      }
    }
    fullyTerminated += 1;
    lastOk = i + 1;
    lineStartByte = i + 1;
  }
  return { terminated: fullyTerminated, last_ok: lastOk };
}
function processLine(cl, seq, source_file, state, events, toolResults, batch) {
  const { type, payload, timestamp } = cl;
  const session_id = state.session_id ?? `codex-unknown:${source_file}`;
  if (type === "session_meta") {
    if (state.session_id === null) {
      if (typeof payload.id === "string") state.session_id = payload.id;
      state.createdMs = uuidV7Ms(payload.id);
      if (typeof payload.subagent_history_start_ordinal === "number") {
        state.historyStart = payload.subagent_history_start_ordinal;
      }
      const origin = payload.source;
      if (payload.thread_source === "subagent" || typeof origin === "object" && origin !== null && "subagent" in origin) {
        state.kind = "subagent";
        const spawn2 = origin?.subagent?.thread_spawn;
        if (typeof spawn2?.parent_thread_id === "string") state.parentId = spawn2.parent_thread_id;
      } else if (origin === "exec") {
        state.kind = "exec";
      }
    }
    if (typeof payload.cwd === "string") state.cwd = payload.cwd;
    if (typeof payload.cli_version === "string") state.version = payload.cli_version;
    const git = payload.git;
    if (git && typeof git.branch === "string") state.git_branch = git.branch;
    return;
  }
  if (type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model;
    if (typeof payload.cwd === "string" && state.cwd === null) state.cwd = payload.cwd;
    return;
  }
  if (type === "compacted") {
    const ev = makeBlankEvent(syntheticUuid(source_file, seq), session_id, timestamp, source_file);
    ev.role = "system";
    const parsed = makeBlankParsed(ev);
    parsed.system_reminders.push({ event_uuid: ev.uuid, session_id, ts: timestamp, category: "compaction", text_excerpt: null });
    events.push(parsed);
    return;
  }
  if (type === "response_item") {
    const itemType = typeof payload.type === "string" ? payload.type : null;
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const uuid2 = syntheticUuid(source_file, seq);
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const name = typeof payload.name === "string" ? payload.name : "<unknown>";
      const args = itemType === "function_call" ? payload.arguments : payload.input;
      const rawArgs = typeof args === "string" ? args : args !== void 0 ? JSON.stringify(args) : null;
      const cap = SHELL_TOOLS.has(name) ? SHELL_TOOL_INPUT_BYTE_CAP : TOOL_INPUT_BYTE_CAP2;
      const input_json = rawArgs !== null ? truncateToolInput(rawArgs, batch, cap) : null;
      const ev = makeBlankEvent(uuid2, session_id, timestamp, source_file);
      ev.role = "assistant";
      ev.model = state.model;
      ev.has_tool_use = 1;
      const parsed = makeBlankParsed(ev);
      parsed.tool_calls.push({
        event_uuid: uuid2,
        session_id,
        ts: timestamp,
        call_id: callId,
        name,
        input_json,
        duration_ms: null,
        is_error: 0,
        result_chars: null,
        git_branch: state.git_branch
      });
      const input = parseObjectLike(args);
      addDerivedToolRows({
        event_uuid: uuid2,
        session_id,
        ts: timestamp,
        name,
        parsed,
        input
      });
      if (rawArgs !== null && rawArgs.includes("*** Begin Patch")) {
        for (const path of patchedFiles(rawArgs, state.cwd)) {
          parsed.file_ops.push({ event_uuid: uuid2, session_id, ts: timestamp, tool: "apply_patch", path });
        }
      }
      if (name === "exec_command" && input !== null && typeof input.cmd === "string") {
        const workdir = typeof input.workdir === "string" ? input.workdir : state.cwd;
        for (const path of shellCommandFiles(input.cmd, workdir, batch)) {
          parsed.file_ops.push({ event_uuid: uuid2, session_id, ts: timestamp, tool: "exec_command", path });
        }
      }
      if (name === "exec" && rawArgs !== null) {
        const { commands, built } = execCodeScan(rawArgs);
        for (const { cmd, workdir } of commands) {
          for (const path of shellCommandFiles(cmd, workdir ?? state.cwd, batch)) {
            parsed.file_ops.push({ event_uuid: uuid2, session_id, ts: timestamp, tool: "exec_command", path });
          }
        }
        if (callId !== null) state.openExec.set(callId, { commands: new Set(commands.map((c) => c.cmd)), built: built > 0 });
        for (const { cmd } of commands) state.namedCommands.add(cmd);
      }
      if (name === "exec_command" && typeof input?.cmd === "string") state.namedCommands.add(input.cmd);
      if (callId !== null) {
        state.callEvents.set(callId, parsed);
        if (name === "exec_command" && typeof input?.cmd === "string") state.openDirect.set(callId, input.cmd);
        if (name === "write_stdin" && typeof input?.session_id === "number") state.stdinTarget.set(callId, input.session_id);
        if (name === "wait" && (typeof input?.cell_id === "string" || typeof input?.cell_id === "number")) {
          state.waitTarget.set(callId, String(input.cell_id));
        }
      }
      events.push(parsed);
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      if (callId !== null) {
        const text = codexOutputText(payload.output);
        const commandFailures = state.failedExec.get(callId);
        state.failedExec.delete(callId);
        const commandFailed = commandFailures !== void 0;
        state.openExec.delete(callId);
        state.openDirect.delete(callId);
        let is_error = commandFailed ? 1 : codexOutputError(text);
        const call = state.callEvents.get(callId);
        const callName = call?.tool_calls[0]?.name;
        const codeMode = callName === "exec" || callName === "wait" ? codeModeOutput(payload.output) : null;
        let excerptText = failedOutputText(text);
        if (codeMode !== null) {
          if (codeMode.failed) is_error = 1;
          excerptText = codeMode.failingText ?? (commandFailures?.join("\n") || codeMode.printedText);
          if (callName === "exec" && codeMode.runningCell !== null) state.runningCell.set(codeMode.runningCell, callId);
        }
        const cell = state.waitTarget.get(callId);
        state.waitTarget.delete(callId);
        const waitedOn = cell === void 0 ? void 0 : state.runningCell.get(cell);
        if (codeMode !== null && cell !== void 0 && waitedOn !== void 0) {
          if (codeMode.runningCell === null) {
            state.runningCell.delete(cell);
            const started = toolResults.get(waitedOn);
            if (codeMode.failed && started !== void 0) {
              toolResults.set(waitedOn, { ...started, is_error: 1, error_excerpt: errorExcerpt(codeMode.failingText ?? codeMode.printedText) });
            }
          }
          is_error = 0;
        }
        const running = headerRunningSession(text);
        const exit = headerExitCode(text);
        if (callName === "exec_command" && running !== null && exit === null) {
          state.runningProcess.set(running, callId);
        }
        const target = state.stdinTarget.get(callId);
        const origin = target === void 0 ? void 0 : state.runningProcess.get(target);
        if (target !== void 0 && exit !== null && origin !== void 0) {
          state.runningProcess.delete(target);
          const started = toolResults.get(origin);
          if (exit !== 0 && started !== void 0) {
            toolResults.set(origin, { ...started, is_error: 1, error_excerpt: errorExcerpt(failedOutputText(text)) });
          }
          is_error = ownFailure(text);
        }
        state.stdinTarget.delete(callId);
        toolResults.set(callId, {
          ts: timestamp,
          is_error,
          result_chars: codepointLength(text),
          error_excerpt: is_error === 1 ? errorExcerpt(excerptText) : null
        });
        const reason = preToolUseReason(text);
        if (reason !== void 0 && call !== void 0) {
          call.hook_blocks.push({
            event_uuid: call.event.uuid,
            session_id,
            ts: timestamp,
            hook_event: "PreToolUse",
            tool: call.tool_calls[0]?.name ?? null,
            call_id: callId,
            reason
          });
        }
      }
    }
    return;
  }
  if (type !== "event_msg") return;
  const msgType = typeof payload.type === "string" ? payload.type : null;
  if (msgType === null) return;
  const uuid = syntheticUuid(source_file, seq);
  if (msgType === "task_started" || msgType === "turn_started") {
    if (state.pendingTok) pushTurnTokens(events, uuid, session_id, timestamp, source_file, state);
    state.pendingInTok = 0;
    state.pendingCachedTok = 0;
    state.pendingOutTok = 0;
    return;
  }
  if (msgType === "task_complete" || msgType === "turn_complete") {
    pushTurnTokens(events, uuid, session_id, timestamp, source_file, state);
    return;
  }
  if (msgType === "turn_aborted") {
    if (state.pendingTok) pushTurnTokens(events, uuid, session_id, timestamp, source_file, state);
    return;
  }
  if (msgType === "token_count") {
    const info = payload.info;
    if (info) {
      const last = info.last_token_usage;
      if (last) {
        if (typeof last.input_tokens === "number") state.pendingInTok = last.input_tokens;
        if (typeof last.cached_input_tokens === "number") state.pendingCachedTok = last.cached_input_tokens;
        if (typeof last.output_tokens === "number") state.pendingOutTok += last.output_tokens;
        state.pendingTok = true;
      }
    }
    return;
  }
  if (msgType === "user_message" || msgType === "agent_message") {
    const text = typeof payload.message === "string" ? payload.message : null;
    if (msgType === "user_message") pushUserMessage(events, uuid, session_id, timestamp, source_file, text);
    else pushAgentMessage(events, uuid, session_id, timestamp, source_file, state.model, text);
    return;
  }
  if (msgType === "item_completed") {
    const item = payload.item;
    const text = item ? itemText(item) : null;
    if (item?.type === "UserMessage") pushUserMessage(events, uuid, session_id, timestamp, source_file, text);
    else if (item?.type === "AgentMessage") pushAgentMessage(events, uuid, session_id, timestamp, source_file, state.model, text);
    else if (item?.type === "HookPrompt") pushHookPrompt(events, uuid, session_id, timestamp, source_file, item);
    else if (item?.type === "CommandExecution") readCommandExecution(item, state, batch);
    else if (item?.type === "McpToolCall") pushExecMcpCall(events, uuid, session_id, timestamp, source_file, item, state, batch);
    return;
  }
  if (msgType === "mcp_tool_call_begin") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const invocation = payload.invocation;
    const toolName = invocation && typeof invocation.tool === "string" ? invocation.tool : "<unknown>";
    const inputRaw = invocation?.arguments !== void 0 ? JSON.stringify(invocation.arguments) : null;
    const input_json = inputRaw !== null ? truncateToolInput(inputRaw, batch) : null;
    const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
    ev.role = "assistant";
    ev.has_tool_use = 1;
    const parsed = makeBlankParsed(ev);
    const toolCall = {
      event_uuid: uuid,
      session_id,
      ts: timestamp,
      call_id: callId,
      name: toolName,
      input_json,
      duration_ms: null,
      is_error: 0,
      result_chars: null,
      git_branch: state.git_branch
    };
    parsed.tool_calls.push(toolCall);
    events.push(parsed);
    return;
  }
  if (msgType === "mcp_tool_call_end") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const isError = detectToolError(payload.result);
    if (callId !== null) {
      toolResults.set(callId, { ts: timestamp, is_error: isError, result_chars: null, error_excerpt: null });
    }
    return;
  }
  if (msgType === "exec_command_begin") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const cmd = Array.isArray(payload.command) ? payload.command.join(" ") : typeof payload.command === "string" ? payload.command : null;
    const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
    ev.role = "assistant";
    ev.has_tool_use = 1;
    const parsed = makeBlankParsed(ev);
    const toolCall = {
      event_uuid: uuid,
      session_id,
      ts: timestamp,
      call_id: callId,
      name: "exec",
      input_json: cmd !== null ? truncateToolInput(cmd, batch, SHELL_TOOL_INPUT_BYTE_CAP) : null,
      duration_ms: null,
      is_error: 0,
      result_chars: null,
      git_branch: state.git_branch
    };
    parsed.tool_calls.push(toolCall);
    events.push(parsed);
    return;
  }
  if (msgType === "exec_command_end") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
    const isError = exitCode !== 0 ? 1 : 0;
    if (callId !== null) {
      toolResults.set(callId, { ts: timestamp, is_error: isError, result_chars: null, error_excerpt: null });
    }
    return;
  }
}
function itemText(item) {
  if (!Array.isArray(item.content)) return null;
  const parts = [];
  for (const part of item.content) {
    if (part === null || typeof part !== "object") continue;
    const p = part;
    if ((p.type === "text" || p.type === "Text") && typeof p.text === "string") parts.push(p.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
function pushTurnTokens(events, uuid, session_id, timestamp, source_file, state) {
  const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
  ev.role = "assistant";
  ev.model = state.model;
  ev.in_tok = state.pendingInTok;
  ev.cache_r = state.pendingCachedTok;
  ev.out_tok = state.pendingOutTok;
  state.pendingInTok = 0;
  state.pendingCachedTok = 0;
  state.pendingOutTok = 0;
  state.pendingTok = false;
  events.push(makeBlankParsed(ev));
}
function pushUserMessage(events, uuid, session_id, timestamp, source_file, text) {
  if (text === null || text.trim().length === 0) return;
  const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
  ev.role = "user";
  ev.has_text = 1;
  ev.text_len = [...text].length;
  const parsed = makeBlankParsed(ev);
  const userText = {
    event_uuid: uuid,
    session_id,
    ts: timestamp,
    text,
    is_command: 0,
    role: "user",
    type: "user_message"
  };
  parsed.user_texts.push(userText);
  for (const skill of extractSkillCandidates(text)) {
    parsed.skill_calls.push({ event_uuid: uuid, session_id, ts: timestamp, skill, args_excerpt: null });
  }
  events.push(parsed);
}
function readCommandExecution(item, state, batch) {
  if (item.source === "user_shell") return;
  const command = Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command;
  if (typeof command !== "string") return;
  for (const cmd of state.openDirect.values()) if (cmd === command) return;
  const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
  const failure = `Process exited with code ${String(item.exit_code)}
${typeof item.aggregated_output === "string" ? item.aggregated_output : ""}`;
  const naming = [...state.openExec].filter(([, open]) => open.commands.has(command)).map(([callId2]) => callId2);
  if (naming.length > 0) {
    if (failed) for (const callId2 of naming) addExecFailure(state, callId2, failure);
    return;
  }
  if (state.namedCommands.has(command)) return;
  const only = state.openExec.size === 1 ? [...state.openExec][0] : void 0;
  if (only === void 0 || !only[1].built) return;
  const callId = only[0];
  const call = state.callEvents.get(callId);
  if (call === void 0) return;
  const { uuid, session_id, ts } = call.event;
  for (const path of shellCommandFiles(command, cwdOf(item.cwd) ?? state.cwd, batch)) {
    call.file_ops.push({ event_uuid: uuid, session_id, ts, tool: "exec_command", path });
  }
  if (failed) addExecFailure(state, callId, failure);
}
function addExecFailure(state, callId, failure) {
  const failures = state.failedExec.get(callId);
  if (failures === void 0) state.failedExec.set(callId, [failure]);
  else failures.push(failure);
}
function pushExecMcpCall(events, uuid, session_id, timestamp, source_file, item, state, batch) {
  const id = item.id;
  if (typeof id !== "string" || !id.startsWith("exec-")) return;
  if (typeof item.server !== "string" || typeof item.tool !== "string") return;
  const ident = (s) => s.replace(/[^A-Za-z0-9_]/g, "_");
  const result = item.result;
  const failed = item.status === "failed" || result !== null && typeof result === "object" && result.isError === true;
  const d = item.duration;
  const raw = item.arguments !== void 0 ? JSON.stringify(item.arguments) : null;
  const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
  ev.role = "assistant";
  ev.model = state.model;
  ev.has_tool_use = 1;
  const parsed = makeBlankParsed(ev);
  parsed.tool_calls.push({
    event_uuid: uuid,
    session_id,
    ts: timestamp,
    call_id: id,
    name: `mcp__${ident(item.server)}__${ident(item.tool)}`,
    input_json: raw !== null ? truncateToolInput(raw, batch) : null,
    duration_ms: typeof d?.secs === "number" && typeof d.nanos === "number" ? Math.round(d.secs * 1e3 + d.nanos / 1e6) : null,
    is_error: failed ? 1 : 0,
    result_chars: null,
    git_branch: state.git_branch
  });
  events.push(parsed);
}
function cwdOf(value) {
  if (typeof value !== "string" || value === "") return null;
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return isAbsolute(value) ? value : null;
}
function pushHookPrompt(events, uuid, session_id, timestamp, source_file, item) {
  if (!Array.isArray(item.fragments)) return;
  const parsed = makeBlankParsed(makeBlankEvent(uuid, session_id, timestamp, source_file));
  for (const fragment of item.fragments) {
    if (fragment === null || typeof fragment !== "object") continue;
    const { text, hookRunId } = fragment;
    if (typeof text !== "string" || typeof hookRunId !== "string") continue;
    const hook_event = hookEventOf(hookRunId);
    if (hook_event === null) continue;
    const reason = text.trim();
    parsed.hook_blocks.push({
      event_uuid: uuid,
      session_id,
      ts: timestamp,
      hook_event,
      tool: null,
      call_id: null,
      reason: reason === "" ? null : utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out
    });
  }
  if (parsed.hook_blocks.length > 0) events.push(parsed);
}
function pushAgentMessage(events, uuid, session_id, timestamp, source_file, model, text) {
  if (text === null || text.trim().length === 0) return;
  const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
  ev.role = "assistant";
  ev.model = model;
  ev.has_text = 1;
  ev.text_len = [...text].length;
  const parsed = makeBlankParsed(ev);
  const { out: clipped } = utf8SafeHeadTailTruncate(text, ASSISTANT_TEXT_BYTE_CAP);
  const assistantText = {
    event_uuid: uuid,
    session_id,
    ts: timestamp,
    text: clipped,
    is_command: 0,
    role: "assistant",
    type: "assistant_message"
  };
  parsed.user_texts.push(assistantText);
  events.push(parsed);
}

// src/indexer/sources.ts
var claudeAdapter = {
  name: "claude",
  sessionsDir: projectsDir,
  parse: parseFileBody,
  // A subagent transcript sits under its parent's directory
  // (<project>/<session>/subagents/…), so its own parent directory is not
  // the project. Either separator: paths are joined with `\` on Windows.
  deriveProjectId: (source_file) => {
    const at = source_file.search(/[\\/]subagents[\\/]/);
    return at === -1 ? null : source_file.slice(0, at).split(/[\\/]/).at(-2) ?? null;
  }
};
var codexAdapter = {
  name: "codex",
  sessionsDir: codexSessionsDir,
  parse: parseCodexFileBody,
  // Codex shards sessions under sessions/YYYY/MM/DD/, so the parent directory
  // is a date fragment, not a project key. Derive from the session cwd
  // instead: the id Claude Code gives the directory, so both sources align.
  deriveProjectId: (_source_file, cwd) => cwd !== null ? projectIdOf(cwd) : null
};
var SOURCE_ADAPTERS = [claudeAdapter, codexAdapter];
function getSourceAdapter(name) {
  const adapter = SOURCE_ADAPTERS.find((a) => a.name === name);
  if (adapter === void 0) throw new Error(`Unknown source adapter: ${name}`);
  return adapter;
}

// src/indexer/cursor.ts
function walkJsonl(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const name = String(ent.name);
    if (name.startsWith(".")) continue;
    const full = join2(root, name);
    if (ent.isDirectory()) walkJsonl(full, out);
    else if (ent.isFile() && name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}
function loadCursorIndex(db) {
  const rows = db.prepare("SELECT * FROM file_cursor").all();
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) m.set(r.path, r);
  return m;
}
function discoverSource(cursorIdx, root, source, opts, out) {
  const files = walkJsonl(root);
  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const mtime = st.mtimeMs / 1e3;
    const size = st.size;
    const prior = cursorIdx.get(path) ?? null;
    const needs = opts.forceRebuild === true || prior === null || mtime > prior.mtime + 1e-6 || size < prior.size;
    out.push({ path, mtime, size, needs_parse: needs, source });
  }
}
function discoverFiles(db, opts = {}, adapters = SOURCE_ADAPTERS) {
  const cursorIdx = loadCursorIndex(db);
  const out = [];
  for (const adapter of adapters) {
    discoverSource(cursorIdx, adapter.sessionsDir(), adapter.name, opts, out);
  }
  return out;
}
function upsertCursor(db, row) {
  db.prepare(
    `INSERT INTO file_cursor (path, mtime, size, lines, last_ok)
     VALUES (@path, @mtime, @size, @lines, @last_ok)
     ON CONFLICT(path) DO UPDATE SET
       mtime=excluded.mtime,
       size=excluded.size,
       lines=excluded.lines,
       last_ok=excluded.last_ok`
  ).run(row);
}

// src/indexer/lang/registry.ts
var registry = /* @__PURE__ */ new Map();
function listKnownLanguageCodes() {
  return ["ko", "ja", "zh"];
}
function registerLanguage(adapter) {
  registry.set(adapter.code, adapter);
}
function getLanguageAdapter(code) {
  return registry.get(code);
}
function languageFtsTable(code) {
  return `user_text_fts_lang_${code}`;
}

// src/indexer/writer.ts
function prepareStatements(db) {
  const insertLanguageFts = /* @__PURE__ */ new Map();
  const selectLanguageTokens = /* @__PURE__ */ new Map();
  for (const code of listKnownLanguageCodes()) {
    const table = languageFtsTable(code);
    insertLanguageFts.set(
      code,
      db.prepare(`INSERT INTO ${table} (rowid, text, session_id, ts) VALUES (?, ?, ?, ?)`)
    );
    selectLanguageTokens.set(
      code,
      db.prepare(
        `SELECT ut.text AS text, l.text AS tokens FROM user_text ut
         JOIN ${table} l ON l.rowid = ut.rowid WHERE ut.session_id = ?`
      )
    );
  }
  return {
    insertLanguageFts,
    selectLanguageTokens,
    insertEvent: db.prepare(
      `INSERT OR REPLACE INTO event
       (uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model,
        in_tok, out_tok, cache_r, cache_w, text_len,
        has_tool_use, has_text, has_tool_res,
        user_turn_no, assistant_turn_no, source_file)
       VALUES
       (@uuid, @session_id, @parent_uuid, @prompt_id, @agent_id, @is_sidechain, @ts, @role, @model,
        @in_tok, @out_tok, @cache_r, @cache_w, @text_len,
        @has_tool_use, @has_text, @has_tool_res,
        @user_turn_no, @assistant_turn_no, @source_file)`
    ),
    insertToolCall: db.prepare(
      `INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, duration_ms, is_error, result_chars, git_branch)
       VALUES (@event_uuid, @session_id, @ts, @call_id, @name, @input_json, @duration_ms, @is_error, @result_chars, @git_branch)`
    ),
    insertFileOp: db.prepare(
      `INSERT INTO file_op (event_uuid, session_id, ts, tool, path)
       VALUES (@event_uuid, @session_id, @ts, @tool, @path)`
    ),
    insertUserText: db.prepare(
      `INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type)
       VALUES (@event_uuid, @session_id, @ts, @text, @is_command, @role, @type)`
    ),
    insertSkillCall: db.prepare(
      `INSERT INTO skill_call (event_uuid, session_id, ts, skill, args_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @skill, @args_excerpt)`
    ),
    insertAgentCall: db.prepare(
      `INSERT INTO agent_call (event_uuid, session_id, ts, subagent_type, description, prompt_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @subagent_type, @description, @prompt_excerpt)`
    ),
    insertSlashCommand: db.prepare(
      `INSERT INTO slash_command (event_uuid, session_id, ts, name)
       VALUES (@event_uuid, @session_id, @ts, @name)`
    ),
    insertSystemReminder: db.prepare(
      `INSERT INTO system_reminder (event_uuid, session_id, ts, category, text_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @category, @text_excerpt)`
    ),
    insertHookBlock: db.prepare(
      `INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason)
       VALUES (@event_uuid, @session_id, @ts, @hook_event, @tool, @call_id, @reason)`
    ),
    insertEventUnknownBlock: db.prepare(
      `INSERT OR REPLACE INTO event_unknown_block (event_uuid, session_id, block_index, raw_json)
       VALUES (@event_uuid, @session_id, @block_index, @raw_json)`
    ),
    insertAnomaly: db.prepare(
      `INSERT INTO anomaly (session_id, ts, kind, count, detail, source_file)
       VALUES (@session_id, @ts, @kind, @count, @detail, @source_file)`
    ),
    wipeAnomaliesForFile: db.prepare(`DELETE FROM anomaly WHERE source_file = ?`),
    updateToolCallResult: db.prepare(
      `UPDATE tool_call
       SET duration_ms = CAST((julianday(@result_ts) - julianday(ts)) * 86400000 AS INTEGER),
           is_error = @is_error,
           result_chars = @result_chars,
           error_excerpt = @error_excerpt
       WHERE call_id = @call_id AND session_id = @session_id AND duration_ms IS NULL`
    ),
    setToolCallResult: db.prepare(
      `UPDATE tool_call
       SET duration_ms = CAST((julianday(@result_ts) - julianday(ts)) * 86400000 AS INTEGER),
           is_error = @is_error,
           result_chars = @result_chars,
           error_excerpt = @error_excerpt
       WHERE call_id = @call_id AND session_id = @session_id`
    ),
    // A file writes only the sessions it holds in full (writableEvents in
    // driver.ts), so its span replaces the stored one, as in a rebuild, which
    // deletes the row first; kept with MIN/MAX, a line the file lost stayed.
    upsertSession: db.prepare(
      `INSERT INTO session (id, project_id, kind, parent_id, started_at, ended_at, cwd, git_branch, model_primary, version, source)
       VALUES (@id, @project_id, @kind, @parent_id, @started_at, @ended_at, @cwd, @git_branch, @model_primary, @version, @source)
       ON CONFLICT(id) DO UPDATE SET
         project_id    = excluded.project_id,
         kind          = excluded.kind,
         parent_id     = excluded.parent_id,
         started_at    = excluded.started_at,
         ended_at      = excluded.ended_at,
         cwd           = COALESCE(excluded.cwd, session.cwd),
         git_branch    = COALESCE(excluded.git_branch, session.git_branch),
         model_primary = COALESCE(excluded.model_primary, session.model_primary),
         version       = COALESCE(excluded.version, session.version),
         source        = excluded.source`
    ),
    upsertProject: db.prepare(
      `INSERT INTO project (id, cwd, display)
       VALUES (@id, @cwd, @display)
       ON CONFLICT(id) DO UPDATE SET
         cwd     = COALESCE(excluded.cwd, project.cwd),
         display = COALESCE(excluded.display, project.display)`
    ),
    wipeEventsForSession: db.prepare(`DELETE FROM event WHERE session_id = ?`),
    // Sessions all of whose event rows came from one file.
    sessionsOnlyInFile: db.prepare(
      `SELECT DISTINCT e.session_id FROM event e WHERE e.source_file = ?
         AND NOT EXISTS (SELECT 1 FROM event o WHERE o.session_id = e.session_id AND o.source_file IS NOT e.source_file)`
    ),
    deleteSession: db.prepare(`DELETE FROM session WHERE id = ?`),
    wipeToolCallsForSession: db.prepare(`DELETE FROM tool_call WHERE session_id = ?`),
    wipeFileOpsForSession: db.prepare(`DELETE FROM file_op WHERE session_id = ?`),
    wipeUserTextsForSession: db.prepare(`DELETE FROM user_text WHERE session_id = ?`),
    wipeSkillCallsForSession: db.prepare(`DELETE FROM skill_call WHERE session_id = ?`),
    wipeAgentCallsForSession: db.prepare(`DELETE FROM agent_call WHERE session_id = ?`),
    wipeSlashCommandsForSession: db.prepare(`DELETE FROM slash_command WHERE session_id = ?`),
    wipeSystemRemindersForSession: db.prepare(`DELETE FROM system_reminder WHERE session_id = ?`),
    wipeHookBlocksForSession: db.prepare(`DELETE FROM hook_block WHERE session_id = ?`),
    wipeUnknownBlocksForSession: db.prepare(`DELETE FROM event_unknown_block WHERE session_id = ?`)
  };
}
function wipeSessions(stmts, sessionIds) {
  for (const sid of sessionIds) {
    stmts.wipeUnknownBlocksForSession.run(sid);
    stmts.wipeToolCallsForSession.run(sid);
    stmts.wipeFileOpsForSession.run(sid);
    stmts.wipeUserTextsForSession.run(sid);
    stmts.wipeSkillCallsForSession.run(sid);
    stmts.wipeAgentCallsForSession.run(sid);
    stmts.wipeSlashCommandsForSession.run(sid);
    stmts.wipeSystemRemindersForSession.run(sid);
    stmts.wipeHookBlocksForSession.run(sid);
    stmts.wipeEventsForSession.run(sid);
  }
}
function knownTokens(stmts, sessionIds) {
  const known = /* @__PURE__ */ new Map();
  for (const code of listKnownLanguageCodes()) {
    if (!getLanguageAdapter(code)) continue;
    const byText = /* @__PURE__ */ new Map();
    const select = stmts.selectLanguageTokens.get(code);
    for (const sid of sessionIds) {
      for (const r of select.all(sid)) byText.set(r.text, r.tokens);
    }
    known.set(code, byText);
  }
  return known;
}
function writeParsedEvent(stmts, p, known) {
  stmts.insertEvent.run(toSqlBindable(p.event));
  for (const r of p.tool_calls) stmts.insertToolCall.run(toSqlBindable(r));
  for (const r of p.file_ops) stmts.insertFileOp.run(toSqlBindable(r));
  for (const r of p.user_texts) {
    const info = stmts.insertUserText.run(toSqlBindable(r));
    insertLanguageLayers(stmts, info.lastInsertRowid, r, known);
  }
  for (const r of p.skill_calls) stmts.insertSkillCall.run(toSqlBindable(r));
  for (const r of p.agent_calls) stmts.insertAgentCall.run(toSqlBindable(r));
  for (const r of p.slash_commands) stmts.insertSlashCommand.run(toSqlBindable(r));
  for (const r of p.system_reminders) stmts.insertSystemReminder.run(toSqlBindable(r));
  for (const r of p.hook_blocks) stmts.insertHookBlock.run(toSqlBindable(r));
  for (const r of p.unknown_blocks) stmts.insertEventUnknownBlock.run(toSqlBindable(r));
}
function insertLanguageLayers(stmts, rowid, r, known) {
  for (const code of listKnownLanguageCodes()) {
    const adapter = getLanguageAdapter(code);
    if (!adapter || !adapter.detect(r.text)) continue;
    const tokens = known?.get(code)?.get(r.text) ?? adapter.tokenize(r.text).join(" ");
    if (!tokens) continue;
    stmts.insertLanguageFts.get(code).run(rowid, tokens, r.session_id, r.ts);
  }
}
function toSqlBindable(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v === void 0) out[k] = null;
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}
function flushAnomalyBatch(stmts, batch) {
  stmts.wipeAnomaliesForFile.run(batch.source_file);
  for (const [kind, { count, detail }] of batch.counters) {
    stmts.insertAnomaly.run({
      session_id: batch.session_id,
      ts: batch.ts,
      kind,
      count,
      detail,
      source_file: batch.source_file
    });
  }
}
function applyToolResults(stmts, results, sessionIds) {
  for (const [call_id, { ts, is_error, result_chars, error_excerpt }] of results) {
    for (const session_id of sessionIds) {
      stmts.updateToolCallResult.run({ call_id, session_id, result_ts: ts, is_error, result_chars, error_excerpt });
    }
  }
}

// src/indexer/append.ts
function readRange(path, start, end) {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < buf.byteLength) {
      const n = readSync(fd, buf, got, buf.byteLength - got, start + got);
      if (n === 0) return null;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}
function readAppended(db, f) {
  const cursor = db.prepare("SELECT path, mtime, size, lines, last_ok FROM file_cursor WHERE path = ?").get(f.path);
  if (cursor === void 0) return "no_cursor";
  if (f.size < cursor.size || f.size < cursor.last_ok) return "shrunk";
  const from = cursor.last_ok > 0 ? cursor.last_ok - 1 : 0;
  const bytes = readRange(f.path, from, f.size);
  if (bytes === null) return "shrunk";
  if (cursor.last_ok > 0 && bytes[0] !== 10) return "not_line_start";
  return { cursor, from, bytes, start: cursor.last_ok - from };
}
function appendNewLines(db, stmts, f) {
  const full = (reason) => ({ kind: "full", reason });
  const read = readAppended(db, f);
  if (typeof read === "string") return full(read);
  const { cursor, from, bytes } = read;
  const batch = {
    counters: /* @__PURE__ */ new Map(),
    session_id: null,
    ts: new Date(Math.floor(f.mtime * 1e3)).toISOString(),
    source_file: f.path
  };
  const toolResults = /* @__PURE__ */ new Map();
  let events = [];
  const meta = { cwd: false, gitBranch: false, version: false, sdkEntrypoint: false };
  let lineStart = read.start;
  let terminated = 0;
  for (let i = lineStart; i < bytes.byteLength; i++) {
    if (bytes[i] !== 10) continue;
    const line = bytes.subarray(lineStart, i).toString("utf8");
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      if (terminated === 0) return full("torn_first_line");
    }
    terminated += 1;
    const p = parseEventLine(line, f.path, cursor.lines + terminated, batch, toolResults);
    if (p !== null) events.push(p);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj;
      if (typeof o.cwd === "string") meta.cwd = true;
      if (typeof o.gitBranch === "string") meta.gitBranch = true;
      if (typeof o.version === "string") meta.version = true;
      if (typeof o.entrypoint === "string" && o.entrypoint.startsWith("sdk-")) meta.sdkEntrypoint = true;
    }
    lineStart = i + 1;
  }
  const subagentFile = SUBAGENT_FILE_RE.test(f.path);
  const fileSessions = db.prepare("SELECT DISTINCT session_id FROM event WHERE source_file = ?").all(f.path).map((r) => r.session_id);
  if (fileSessions.length === 0) return full("no_session_row");
  const own = subagentFile ? fileSessions[0] : basename(f.path, ".jsonl");
  if (fileSessions.length > 1 || fileSessions[0] !== own) return full("several_sessions");
  if (!subagentFile && db.prepare("SELECT 1 FROM anomaly WHERE source_file = ? AND kind = 'copied_session_line_skipped' LIMIT 1").get(f.path) !== void 0) {
    return full("copied_lines");
  }
  if (subagentFile) {
    const kept2 = events.filter((p) => p.event.agent_id !== null && p.event.session_id === agentSessionId(p.event.agent_id));
    const skipped = events.length - kept2.length;
    if (skipped > 0) {
      const cur = batch.counters.get("subagent_line_skipped");
      if (cur) cur.count += skipped;
      else batch.counters.set("subagent_line_skipped", { count: skipped, detail: null });
    }
    events = kept2;
  }
  const session = db.prepare("SELECT kind, parent_id, started_at, ended_at, cwd, git_branch, version, model_primary FROM session WHERE id = ?").get(own);
  if (session === void 0) return full("no_session_row");
  if (events.some((p) => p.event.session_id !== own)) return full("other_session");
  if (db.prepare("SELECT 1 FROM event WHERE session_id = ? AND source_file IS NOT ? LIMIT 1").get(own, f.path) !== void 0) {
    return full("several_files");
  }
  if (session.cwd === null && meta.cwd || session.git_branch === null && meta.gitBranch || session.version === null && meta.version || subagentFile && session.parent_id === null && events.length > 0) {
    return full("late_meta");
  }
  if (session.kind === "interactive" && meta.sdkEntrypoint) return full("sdk_entrypoint");
  if (session.kind !== "subagent" && events.some((p) => p.event.is_sidechain === 1)) return full("sidechain");
  const knownUuid = db.prepare("SELECT 1 FROM event WHERE uuid = ?");
  if (events.some((p) => knownUuid.get(p.event.uuid) !== void 0)) return full("known_uuid");
  const answered = db.prepare("SELECT 1 FROM tool_call WHERE call_id = ? AND duration_ms IS NOT NULL LIMIT 1");
  for (const callId of toolResults.keys()) {
    if (answered.get(callId) !== void 0) return full("result_exists");
  }
  return finishAppend(db, stmts, {
    f,
    cursor,
    own,
    session,
    events,
    batch,
    terminated,
    last_ok: from + lineStart,
    writeExtra: () => applyToolResults(stmts, toolResults, [own])
  });
}
function finishAppend(db, stmts, args) {
  const { f, cursor, own, session, events, batch, terminated, last_ok, writeExtra } = args;
  const full = (reason) => ({ kind: "full", reason });
  assignTurnNumbers(events);
  const last = db.prepare(
    `SELECT MAX(ts) AS ts, MAX(user_turn_no) AS user_turn_no, MAX(assistant_turn_no) AS assistant_turn_no FROM event
       WHERE session_id = ? AND (user_turn_no IS NOT NULL OR assistant_turn_no IS NOT NULL)`
  ).get(own);
  const numbered = events.filter((p) => p.event.user_turn_no !== null || p.event.assistant_turn_no !== null);
  if (last.ts !== null && numbered.some((p) => p.event.ts < last.ts)) return full("out_of_order");
  let primaryModel = session.model_primary;
  const newModels = events.filter((p) => p.event.role === "assistant" && typeof p.event.model === "string");
  if (newModels.length > 0) {
    const counts = /* @__PURE__ */ new Map();
    const stored = db.prepare("SELECT model, COUNT(*) AS n FROM event WHERE session_id = ? AND role = 'assistant' AND model IS NOT NULL GROUP BY model").all(own);
    for (const r of stored) counts.set(r.model, r.n);
    for (const p of newModels) counts.set(p.event.model, (counts.get(p.event.model) ?? 0) + 1);
    const ranked = [...counts].sort((x, y) => y[1] - x[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return full("model_tie");
    primaryModel = ranked[0][0];
  }
  db.transaction(() => {
    for (const p of events) {
      if (p.event.user_turn_no !== null) p.event.user_turn_no += last.user_turn_no ?? 0;
      if (p.event.assistant_turn_no !== null) p.event.assistant_turn_no += last.assistant_turn_no ?? 0;
      writeParsedEvent(stmts, p);
    }
    writeExtra();
    let startedAt = session.started_at;
    let endedAt = session.ended_at;
    for (const p of events) {
      if (startedAt === null || p.event.ts < startedAt) startedAt = p.event.ts;
      if (endedAt === null || p.event.ts > endedAt) endedAt = p.event.ts;
    }
    db.prepare("UPDATE session SET started_at = ?, ended_at = ?, model_primary = ? WHERE id = ?").run(
      startedAt,
      endedAt,
      primaryModel,
      own
    );
    const stored = db.prepare("SELECT kind, count, detail, session_id FROM anomaly WHERE source_file = ?").all(f.path);
    const merged = new Map(stored.map((r) => [r.kind, { count: r.count, detail: r.detail }]));
    for (const [kind, { count, detail }] of batch.counters) {
      const m = merged.get(kind);
      if (m === void 0) merged.set(kind, { count, detail });
      else {
        m.count += count;
        if (detail !== null) m.detail = detail;
      }
    }
    const anomalySession = stored.length > 0 ? stored[0].session_id : own;
    stmts.wipeAnomaliesForFile.run(f.path);
    for (const [kind, { count, detail }] of merged) {
      stmts.insertAnomaly.run({ session_id: anomalySession, ts: batch.ts, kind, count, detail, source_file: f.path });
    }
    upsertCursor(db, {
      path: f.path,
      mtime: f.mtime,
      size: f.size,
      lines: cursor.lines + terminated,
      last_ok
    });
  })();
  return { kind: "appended", events: events.length, parse_errors: batch.counters.get("json_parse_error")?.count ?? 0 };
}

// src/indexer/codex_skills.ts
import { existsSync } from "node:fs";
import { join as join3 } from "node:path";
function isKnownCodexSkill(name, cwd) {
  if (existsSync(join3(codexHome(), "skills", name))) return true;
  if (cwd !== null && existsSync(join3(cwd, ".codex", "skills", name))) return true;
  return false;
}
function filterCodexSkillCandidates(events, cwd, decisions = /* @__PURE__ */ new Map()) {
  for (const p of events) {
    if (p.skill_calls.length === 0) continue;
    for (const sc of p.skill_calls) {
      if (!decisions.has(sc.skill)) decisions.set(sc.skill, isKnownCodexSkill(sc.skill, cwd));
    }
    p.skill_calls = p.skill_calls.filter((sc) => decisions.get(sc.skill) === true);
  }
  return decisions;
}
function skillDecisionsHold(decisions, cwd) {
  for (const [name, kept2] of decisions) {
    if (isKnownCodexSkill(name, cwd) !== kept2) return false;
  }
  return true;
}

// src/indexer/codex_append.ts
var CODEX_STATES_KEPT = 16;
var kept = /* @__PURE__ */ new Map();
function keepCodexState(path, resume, last_ok, lines, skills, prefilled) {
  kept.delete(path);
  if (resume === null) return;
  kept.set(path, { resume, last_ok, lines, skills, prefilled });
  for (const oldest of kept.keys()) {
    if (kept.size <= CODEX_STATES_KEPT) break;
    kept.delete(oldest);
  }
}
function prefilledCallIds(events, into = /* @__PURE__ */ new Set()) {
  for (const p of events) {
    for (const c of p.tool_calls) if (c.call_id !== null && c.duration_ms !== null) into.add(c.call_id);
  }
  return into;
}
function childCounts(p) {
  return [
    p.tool_calls.length,
    p.file_ops.length,
    p.user_texts.length,
    p.skill_calls.length,
    p.agent_calls.length,
    p.slash_commands.length,
    p.system_reminders.length,
    p.hook_blocks.length,
    p.unknown_blocks.length
  ];
}
var FILE_OPS = 1;
var HOOK_BLOCKS = 7;
function appendCodexLines(db, stmts, f) {
  const full = (reason) => ({ kind: "full", reason });
  const entry = kept.get(f.path);
  kept.delete(f.path);
  const read = readAppended(db, f);
  if (typeof read === "string") return full(read);
  const { cursor, from, bytes, start } = read;
  if (entry === void 0 || entry.last_ok !== cursor.last_ok || entry.lines !== cursor.lines) return full("no_state");
  const { state, toolResults } = entry.resume;
  if (!skillDecisionsHold(entry.skills, state.cwd)) return full("skills_changed");
  const firstEnd = bytes.indexOf(10, start);
  if (firstEnd !== -1) {
    try {
      JSON.parse(bytes.subarray(start, firstEnd).toString("utf8"));
    } catch {
      return full("torn_first_line");
    }
  }
  const metaOf = () => [state.session_id, state.cwd, state.git_branch, state.version, state.kind, state.parentId];
  const metaBefore = metaOf();
  const countsBefore = /* @__PURE__ */ new Map();
  for (const p of state.callEvents.values()) countsBefore.set(p, childCounts(p));
  const resultsBefore = new Map(toolResults);
  const batch = {
    counters: /* @__PURE__ */ new Map(),
    session_id: null,
    ts: new Date(Math.floor(f.mtime * 1e3)).toISOString(),
    source_file: f.path
  };
  const events = [];
  const parsed = parseCodexLines({
    buf: bytes,
    start,
    first_seq: cursor.lines + 1,
    source_file: f.path,
    resume: entry.resume,
    batch,
    events
  });
  const skills = filterCodexSkillCandidates(events, state.cwd, new Map(entry.skills));
  if (metaOf().some((v, i) => v !== metaBefore[i])) return full("meta_changed");
  const own = state.session_id;
  if (own === null) return full("no_session_row");
  const session = db.prepare("SELECT kind, parent_id, started_at, ended_at, cwd, git_branch, version, model_primary FROM session WHERE id = ?").get(own);
  if (session === void 0) return full("no_session_row");
  if (db.prepare("SELECT 1 FROM event WHERE source_file = ? AND session_id IS NOT ? LIMIT 1").get(f.path, own) !== void 0) {
    return full("several_sessions");
  }
  if (events.some((p) => p.event.session_id !== own)) return full("other_session");
  if (db.prepare("SELECT 1 FROM event WHERE session_id = ? AND source_file IS NOT ? LIMIT 1").get(own, f.path) !== void 0) {
    return full("several_files");
  }
  const grown = [];
  for (const [p, before] of countsBefore) {
    const now = childCounts(p);
    if (now.every((n, i) => n === before[i])) continue;
    if (now.some((n, i) => i !== FILE_OPS && i !== HOOK_BLOCKS && n !== before[i])) return full("earlier_event_changed");
    grown.push([p, before]);
  }
  const knownUuid = db.prepare("SELECT 1 FROM event WHERE uuid = ?");
  if (events.some((p) => knownUuid.get(p.event.uuid) !== void 0)) return full("known_uuid");
  const prefilled = prefilledCallIds(events, new Set(entry.prefilled));
  const elsewhere = db.prepare("SELECT 1 FROM tool_call WHERE call_id = ? AND session_id IS NOT ? LIMIT 1");
  const ownRows = db.prepare(
    `SELECT o.call_id AS call_id, o.duration_ms IS NOT NULL AS filled,
              EXISTS (SELECT 1 FROM tool_call x WHERE x.call_id = o.call_id AND x.session_id IS NOT o.session_id) AS shared
       FROM tool_call o WHERE o.session_id = ? AND o.call_id IS NOT NULL`
  ).all(own);
  const ownIds = /* @__PURE__ */ new Set();
  for (const r of ownRows) {
    if (r.shared || r.filled && !resultsBefore.has(r.call_id) && !prefilled.has(r.call_id)) return full("shared_call_id");
    ownIds.add(r.call_id);
  }
  const rowsOf = /* @__PURE__ */ new Map();
  for (const r of ownRows) rowsOf.set(r.call_id, (rowsOf.get(r.call_id) ?? 0) + 1);
  for (const p of events) for (const c of p.tool_calls) if (c.call_id !== null) rowsOf.set(c.call_id, (rowsOf.get(c.call_id) ?? 0) + 1);
  for (const id of prefilled) if ((rowsOf.get(id) ?? 0) > 1) return full("prefilled_result");
  for (const p of events) {
    for (const c of p.tool_calls) if (c.call_id !== null && !ownIds.has(c.call_id) && elsewhere.get(c.call_id, own) !== void 0) return full("shared_call_id");
  }
  for (const id of toolResults.keys()) if (!ownIds.has(id) && elsewhere.get(id, own) !== void 0) return full("shared_call_id");
  const newCalls = new Set(events.flatMap((p) => p.tool_calls.map((c) => c.call_id)));
  const results = [...toolResults].filter(([id, r]) => resultsBefore.get(id) !== r || newCalls.has(id));
  if (results.some(([id]) => prefilled.has(id))) return full("prefilled_result");
  const last_ok = from + parsed.last_ok;
  const lines = cursor.lines + parsed.terminated;
  const outcome = finishAppend(db, stmts, {
    f,
    cursor,
    own,
    session,
    events,
    batch,
    terminated: parsed.terminated,
    last_ok,
    writeExtra: () => {
      for (const [p, before] of grown) {
        for (const r of p.file_ops.slice(before[FILE_OPS])) stmts.insertFileOp.run(toSqlBindable(r));
        for (const r of p.hook_blocks.slice(before[HOOK_BLOCKS])) stmts.insertHookBlock.run(toSqlBindable(r));
      }
      for (const [call_id, r] of results) {
        stmts.setToolCallResult.run({
          call_id,
          session_id: own,
          result_ts: r.ts,
          is_error: r.is_error,
          result_chars: r.result_chars,
          error_excerpt: r.error_excerpt
        });
      }
    }
  });
  if (outcome.kind === "appended") keepCodexState(f.path, entry.resume, last_ok, lines, skills, prefilled);
  return outcome;
}

// src/indexer/schema.ts
var SCHEMA_VERSION = 22;
function languageTableStatements(code) {
  const table = languageFtsTable(code);
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(
       text,
       session_id UNINDEXED,
       ts         UNINDEXED,
       tokenize   = 'unicode61'
    )`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_ad
       AFTER DELETE ON user_text BEGIN
         DELETE FROM ${table} WHERE rowid = old.rowid;
       END`
  ];
}
function eventTableStatement(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     uuid              TEXT NOT NULL,
     session_id        TEXT NOT NULL,
     parent_uuid       TEXT,
     prompt_id         TEXT,
     agent_id          TEXT,
     is_sidechain      INTEGER,
     ts                TEXT NOT NULL,
     role              TEXT,
     model             TEXT,
     in_tok            INTEGER DEFAULT 0,
     out_tok           INTEGER DEFAULT 0,
     cache_r           INTEGER DEFAULT 0,
     cache_w           INTEGER DEFAULT 0,
     text_len          INTEGER DEFAULT 0,
     has_tool_use      INTEGER DEFAULT 0,
     has_text          INTEGER DEFAULT 0,
     has_tool_res      INTEGER DEFAULT 0,
     user_turn_no      INTEGER,
     assistant_turn_no INTEGER,
     source_file       TEXT,
     PRIMARY KEY (uuid, session_id),
     FOREIGN KEY (session_id) REFERENCES session(id)
   )`;
}
var EVENT_COLUMNS = "uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model, in_tok, out_tok, cache_r, cache_w, text_len, has_tool_use, has_text, has_tool_res, user_turn_no, assistant_turn_no, source_file";
function unknownBlockTableStatement(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     event_uuid  TEXT NOT NULL,
     block_index INTEGER NOT NULL,
     raw_json    TEXT NOT NULL,
     session_id  TEXT,
     PRIMARY KEY (event_uuid, session_id, block_index),
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`;
}
var SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,
  // ----- File cursor (incremental indexing state) -----
  `CREATE TABLE IF NOT EXISTS file_cursor (
     path     TEXT PRIMARY KEY,
     mtime    REAL NOT NULL,
     size     INTEGER NOT NULL,
     lines    INTEGER NOT NULL,
     last_ok  INTEGER NOT NULL,
     -- no longer written or read; kept so the schema does not change
     live     INTEGER NOT NULL DEFAULT 0
   )`,
  // ----- Upkeep state (not derived from transcripts; digest.ts leaves it out) -----
  // key 'fts_optimized_at': epoch ms of the last FTS 'optimize' (driver.ts).
  // A new table and no derived rows, so no SCHEMA_VERSION bump.
  `CREATE TABLE IF NOT EXISTS maintenance (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL
   )`,
  // ----- Project / Session -----
  `CREATE TABLE IF NOT EXISTS project (
     id       TEXT PRIMARY KEY,
     cwd      TEXT,
     display  TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS session (
     id            TEXT PRIMARY KEY,
     project_id    TEXT,
     kind          TEXT,
     parent_id     TEXT,
     started_at    TEXT,
     ended_at      TEXT,
     cwd           TEXT,
     git_branch    TEXT,
     model_primary TEXT,
     version       TEXT,
     source        TEXT NOT NULL DEFAULT 'claude',
     FOREIGN KEY (project_id) REFERENCES project(id)
   )`,
  // ----- Event (one row per JSONL line and session, multi-block messages stay as one) -----
  eventTableStatement("event"),
  `CREATE INDEX IF NOT EXISTS event_user_turn_idx ON event(session_id, user_turn_no)`,
  `CREATE INDEX IF NOT EXISTS event_session_idx ON event(session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS event_ts_idx ON event(ts)`,
  `CREATE INDEX IF NOT EXISTS event_source_file_idx ON event(source_file)`,
  // ----- Event-unknown-block (forensic store for unrecognized block types) -----
  unknownBlockTableStatement("event_unknown_block"),
  // ----- Tool calls -----
  `CREATE TABLE IF NOT EXISTS tool_call (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     call_id     TEXT,
     name        TEXT NOT NULL,
     input_json  TEXT,
     duration_ms INTEGER,
     is_error    INTEGER DEFAULT 0,
     result_chars INTEGER,
     error_excerpt TEXT,
     git_branch  TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS tool_session_idx ON tool_call(session_id)`,
  `CREATE INDEX IF NOT EXISTS tool_name_idx ON tool_call(name)`,
  // A session's calls of some tools (the session record's git commands):
  // without it SQLite took tool_name_idx and read every shell call in the
  // index. Only an index, so no SCHEMA_VERSION bump: the next open adds it.
  `CREATE INDEX IF NOT EXISTS tool_session_name_idx ON tool_call(session_id, name)`,
  `CREATE INDEX IF NOT EXISTS tool_call_id_idx ON tool_call(call_id)`,
  // ----- File operations -----
  `CREATE TABLE IF NOT EXISTS file_op (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     tool        TEXT NOT NULL,
     path        TEXT NOT NULL,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS file_op_path_idx ON file_op(path)`,
  // A session's edits (clens_left_off) and the indexer's per-session wipe
  // read the whole table without it. No SCHEMA_VERSION bump, as above.
  `CREATE INDEX IF NOT EXISTS file_op_session_tool_idx ON file_op(session_id, tool)`,
  // ----- User and assistant text -----
  `CREATE TABLE IF NOT EXISTS user_text (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     text        TEXT NOT NULL,
     is_command  INTEGER DEFAULT 0,
     role        TEXT NOT NULL DEFAULT 'user',
     type        TEXT NOT NULL DEFAULT 'user_message',
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS user_text_session_ts_idx ON user_text(session_id, ts)`,
  // ----- FTS5 full-text index over user_text -----
  `CREATE VIRTUAL TABLE IF NOT EXISTS user_text_fts USING fts5(
     text,
     session_id UNINDEXED,
     ts         UNINDEXED,
     content    = 'user_text',
     content_rowid = 'rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_ai
     AFTER INSERT ON user_text BEGIN
       INSERT INTO user_text_fts(rowid, text, session_id, ts)
       VALUES (new.rowid, new.text, new.session_id, new.ts);
     END`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_ad
     AFTER DELETE ON user_text BEGIN
       INSERT INTO user_text_fts(user_text_fts, rowid, text, session_id, ts)
       VALUES ('delete', old.rowid, old.text, old.session_id, old.ts);
     END`,
  // ----- FTS5 trigram index (substring / partial-word matching) -----
  // External content (content = 'user_text'), same as user_text_fts above —
  // this table previously kept its own full copy of every row's text in its
  // internal _content shadow table (verified: ~39MB of pure duplication of
  // data user_text already stores), never actually read by search.ts (which
  // always JOINs back to user_text for the displayed text regardless of
  // which FTS layer matched). Pointing it at user_text instead eliminates
  // that duplication with no behavior change (verified: identical MATCH/
  // rank results before and after, same rowids in the same order).
  `CREATE VIRTUAL TABLE IF NOT EXISTS user_text_fts_trigram USING fts5(
     text,
     session_id UNINDEXED,
     ts         UNINDEXED,
     tokenize      = 'trigram',
     content       = 'user_text',
     content_rowid = 'rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_trigram_ai
     AFTER INSERT ON user_text BEGIN
       INSERT INTO user_text_fts_trigram(rowid, text, session_id, ts)
       VALUES (new.rowid, new.text, new.session_id, new.ts);
     END`,
  // External content tables can't reconstruct a deleted row's old column
  // values from user_text after the fact (there's no shadow copy to fall
  // back on) — the special 'delete' command below passes them explicitly
  // from the trigger's old.* row, same pattern as user_text_fts_ad above.
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_trigram_ad
     AFTER DELETE ON user_text BEGIN
       INSERT INTO user_text_fts_trigram(user_text_fts_trigram, rowid, text, session_id, ts)
       VALUES ('delete', old.rowid, old.text, old.session_id, old.ts);
     END`,
  // ----- FTS5 per-language morpheme-normalized layers (optional install) -----
  ...listKnownLanguageCodes().flatMap(languageTableStatements),
  // ----- Skill / Agent / Slash command -----
  `CREATE TABLE IF NOT EXISTS skill_call (
     event_uuid   TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     ts           TEXT NOT NULL,
     skill        TEXT NOT NULL,
     args_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS skill_name_idx ON skill_call(skill)`,
  `CREATE TABLE IF NOT EXISTS agent_call (
     event_uuid     TEXT NOT NULL,
     session_id     TEXT NOT NULL,
     ts             TEXT NOT NULL,
     subagent_type  TEXT NOT NULL,
     description    TEXT,
     prompt_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS agent_type_idx ON agent_call(subagent_type)`,
  `CREATE TABLE IF NOT EXISTS slash_command (
     event_uuid TEXT NOT NULL,
     session_id TEXT NOT NULL,
     ts         TEXT NOT NULL,
     name       TEXT NOT NULL,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS slash_name_idx ON slash_command(name)`,
  `CREATE TABLE IF NOT EXISTS system_reminder (
     event_uuid   TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     ts           TEXT NOT NULL,
     category     TEXT NOT NULL,
     text_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS system_reminder_cat_idx ON system_reminder(category)`,
  // One row per hook refusal: a PreToolUse block (from the blocked call's
  // error result; tool and call_id set) or a Stop block (from its
  // hook_blocking_error attachment; tool and call_id NULL).
  `CREATE TABLE IF NOT EXISTS hook_block (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     hook_event  TEXT NOT NULL,
     tool        TEXT,
     call_id     TEXT,
     reason      TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS hook_block_session_idx ON hook_block(session_id)`,
  // ----- Anomaly bucket (lifecycle per §7) -----
  // `source_file` is a v1 implementation detail (not in the spec's column list)
  // so incremental re-parses can wipe their own per-file anomaly rows before
  // re-flushing — keeps `clens stats --digest` deterministic between
  // incremental and rebuild paths (gate 2). Reports still aggregate via
  // `SELECT kind, SUM(count) GROUP BY kind`, so the extra column is transparent
  // to downstream consumers.
  `CREATE TABLE IF NOT EXISTS anomaly (
     session_id   TEXT,
     ts           TEXT,
     kind         TEXT NOT NULL,
     count        INTEGER NOT NULL DEFAULT 1,
     detail       TEXT,
     source_file  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS anomaly_kind_idx ON anomaly(kind)`,
  `CREATE INDEX IF NOT EXISTS anomaly_source_file_idx ON anomaly(source_file)`
];
function applySchema(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = OFF");
  db.pragma("synchronous = NORMAL");
  migrateToSessionKeys(db);
  const initTx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    const toolCallColumns = db.prepare("PRAGMA table_info(tool_call)").all();
    if (!toolCallColumns.some((c) => c.name === "result_chars")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN result_chars INTEGER");
    }
    if (!toolCallColumns.some((c) => c.name === "error_excerpt")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN error_excerpt TEXT");
    }
    if (!toolCallColumns.some((c) => c.name === "git_branch")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN git_branch TEXT");
    }
    const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get();
    if (!row) {
      db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(SCHEMA_VERSION);
    }
  });
  initTx();
}
function migrateToSessionKeys(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
  db.transaction(() => {
    const blockColumns = columns("event_unknown_block");
    if (blockColumns.length > 0 && !blockColumns.some((c) => c.name === "session_id")) {
      db.exec(unknownBlockTableStatement("event_unknown_block_v19"));
      db.exec(
        `INSERT INTO event_unknown_block_v19 (event_uuid, session_id, block_index, raw_json)
         SELECT k.event_uuid, e.session_id, k.block_index, k.raw_json
         FROM event_unknown_block k JOIN event e ON e.uuid = k.event_uuid`
      );
      db.exec("DROP TABLE event_unknown_block");
      db.exec("ALTER TABLE event_unknown_block_v19 RENAME TO event_unknown_block");
    } else if (blockColumns.length > 0) {
      db.exec("DELETE FROM event_unknown_block WHERE session_id IS NULL");
    }
    const eventKey = columns("event").filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (eventKey.length === 1 && eventKey[0] === "uuid") {
      db.exec(eventTableStatement("event_v19"));
      db.exec(`INSERT INTO event_v19 (${EVENT_COLUMNS}) SELECT ${EVENT_COLUMNS} FROM event ORDER BY uuid, session_id`);
      db.exec("DROP TABLE event");
      db.exec("ALTER TABLE event_v19 RENAME TO event");
    }
  })();
}
function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get();
    return row?.v ?? null;
  } catch {
    return null;
  }
}

// src/indexer/lang/init.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join4, resolve as resolve2 } from "node:path";

// src/indexer/lang/ko.ts
var HANGUL_RE = /[가-힣]/;
function hasHangul(text) {
  return HANGUL_RE.test(text);
}
var CONTENT_S_TAGS = /* @__PURE__ */ new Set(["SL", "SH", "SN"]);
function isContentTag(tag) {
  if (/^[JE]/.test(tag)) return false;
  if (tag.startsWith("S")) return CONTENT_S_TAGS.has(tag);
  return true;
}
var MAX_TOKENIZE_LENGTH = 2e4;
function createKoreanAdapter(kiwi) {
  return {
    code: "ko",
    detect: hasHangul,
    tokenize(text) {
      if (!hasHangul(text) || text.length > MAX_TOKENIZE_LENGTH) return [];
      try {
        return kiwi.analyze(text).tokens.filter((t) => isContentTag(t.tag)).map((t) => t.str).filter(Boolean);
      } catch {
        return [];
      }
    }
  };
}

// src/indexer/lang/scripts.ts
var KANA_RE = /[぀-ヿ]/;
function hasKana(text) {
  return KANA_RE.test(text);
}
var HAN_RE = /[一-鿿]/;
function hasHan(text) {
  return HAN_RE.test(text);
}

// src/indexer/lang/ja.ts
function detectJapanese(text) {
  return hasKana(text) || hasHan(text);
}
function isContentTag2(pos) {
  return pos !== "\u52A9\u8A5E" && pos !== "\u52A9\u52D5\u8A5E" && pos !== "UNK";
}
var MAX_TOKENIZE_LENGTH2 = 2e4;
function indexForm(t) {
  return t.baseForm && t.baseForm !== "*" ? t.baseForm : t.surface;
}
function createJapaneseAdapter(tokenizer) {
  return {
    code: "ja",
    detect: detectJapanese,
    tokenize(text) {
      if (!detectJapanese(text) || text.length > MAX_TOKENIZE_LENGTH2) return [];
      try {
        return tokenizer.tokenize(text).filter((t) => isContentTag2(t.partOfSpeech)).map(indexForm).filter(Boolean);
      } catch {
        return [];
      }
    }
  };
}

// src/indexer/lang/zh.ts
function hasHan2(text) {
  return hasHan(text) && !hasKana(text);
}
function isContentTag3(pos) {
  return pos !== "UNK";
}
var MAX_TOKENIZE_LENGTH3 = 2e4;
function createChineseAdapter(tokenizer) {
  return {
    code: "zh",
    detect: hasHan2,
    tokenize(text) {
      if (!hasHan2(text) || text.length > MAX_TOKENIZE_LENGTH3) return [];
      try {
        return tokenizer.tokenize(text).filter((t) => isContentTag3(t.partOfSpeech)).map((t) => t.surface).filter(Boolean);
      } catch {
        return [];
      }
    }
  };
}

// src/indexer/lang/init.ts
var LINDERA_PACKAGES = {
  ja: { name: "lindera-wasm-nodejs-ipadic", version: "2.0.0", dictionary: "embedded://ipadic" },
  zh: { name: "lindera-wasm-nodejs-cc-cedict", version: "2.0.0", dictionary: "embedded://cc-cedict" }
};
var attempted = false;
function logLoadFailure(code, e) {
  if (process.env.CLENS_DEV === "1") {
    console.error(`clens: failed to load the ${code} language adapter:`, e);
  }
}
async function ensureLanguageAdaptersLoaded() {
  if (attempted) return;
  attempted = true;
  await tryLoadKorean();
  await tryLoadJapanese();
  await tryLoadChinese();
}
async function tryLoadKorean() {
  if (getLanguageAdapter("ko")) return;
  const modelDir = languageModelDir("ko");
  if (!existsSync2(modelDir)) return;
  try {
    const { KiwiBuilder, Match } = await import("kiwi-nlp");
    const kiwiEntry = createRequire(import.meta.url).resolve("kiwi-nlp");
    const wasmPath = join4(dirname(kiwiEntry), "kiwi-wasm.wasm");
    const modelFiles = {};
    for (const name of readdirSync2(modelDir)) {
      modelFiles[name] = new Uint8Array(readFileSync(join4(modelDir, name)));
    }
    const builder = await KiwiBuilder.create(wasmPath);
    const kiwi = await builder.build({ modelFiles });
    registerLanguage(
      createKoreanAdapter({
        analyze: (text) => kiwi.analyze(text, Match.allWithNormalizing)
      })
    );
  } catch (e) {
    logLoadFailure("ko", e);
  }
}
function installedLinderaTokenizer(code) {
  const { name, dictionary } = LINDERA_PACKAGES[code];
  const dir = languageModelDir(code);
  if (!existsSync2(join4(dir, "node_modules", name, "package.json"))) return void 0;
  const { TokenizerBuilder } = createRequire(resolve2(dir, "package.json"))(name);
  const builder = new TokenizerBuilder();
  builder.setDictionary(dictionary);
  builder.setMode("normal");
  return builder.build();
}
async function tryLoadJapanese() {
  if (getLanguageAdapter("ja")) return;
  try {
    const tokenizer = installedLinderaTokenizer("ja");
    if (tokenizer) registerLanguage(createJapaneseAdapter(tokenizer));
  } catch (e) {
    logLoadFailure("ja", e);
  }
}
async function tryLoadChinese() {
  if (getLanguageAdapter("zh")) return;
  try {
    const tokenizer = installedLinderaTokenizer("zh");
    if (tokenizer) registerLanguage(createChineseAdapter(tokenizer));
  } catch (e) {
    logLoadFailure("zh", e);
  }
}

// src/indexer/driver.ts
var LOCK_RETRY_MS = 100;
async function acquireLock(path, timeoutMs, onLost = (err) => console.error(`clens: lost lock ${path}:`, err.message)) {
  const start = Date.now();
  mkdirSync(dirname2(path), { recursive: true });
  if (!existsSync3(path)) {
    const fs = await import("node:fs");
    fs.writeFileSync(path, "");
  }
  for (; ; ) {
    try {
      const release = await import_proper_lockfile.default.lock(path, { retries: 0, stale: 6e4, onCompromised: onLost });
      return () => release().catch((e) => {
        if (e.code !== "ERELEASED") throw e;
      });
    } catch (e) {
      const msg = e.message ?? "";
      if (e.code !== "ELOCKED" && !/ELOCKED|Lock file/i.test(msg)) {
        throw e;
      }
      if (Date.now() - start >= timeoutMs) {
        const err = new Error("indexer busy");
        err.exitCode = 4;
        throw err;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}
function openIndex() {
  mkdirSync(clensHome(), { recursive: true });
  const db = new Database(indexDbPath());
  applySchema(db);
  return db;
}
function deriveSessionKind(args) {
  if (SUBAGENT_FILE_RE.test(args.source_file)) return "subagent";
  if (args.any_sidechain) return "subagent";
  if (args.cwd === judgeCwdDir()) return "pipeline";
  if (args.recorded) return args.recorded;
  return "interactive";
}
function deriveProjectId(source, filePath, cwd) {
  return getSourceAdapter(source).deriveProjectId?.(filePath, cwd) ?? basename2(dirname2(filePath));
}
function summarizeFile(events) {
  const out = {
    events,
    affected_sessions: /* @__PURE__ */ new Set(),
    any_sidechain: false,
    earliest_ts: null,
    latest_ts: null,
    primary_model: null
  };
  const modelCount = /* @__PURE__ */ new Map();
  for (const p of events) {
    const e = p.event;
    out.affected_sessions.add(e.session_id);
    if (e.is_sidechain === 1) out.any_sidechain = true;
    if (out.earliest_ts === null || e.ts < out.earliest_ts) out.earliest_ts = e.ts;
    if (out.latest_ts === null || e.ts > out.latest_ts) out.latest_ts = e.ts;
    if (e.role === "assistant" && typeof e.model === "string") {
      modelCount.set(e.model, (modelCount.get(e.model) ?? 0) + 1);
    }
  }
  if (modelCount.size > 0) {
    out.primary_model = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return out;
}
function commitFile(args) {
  const {
    db,
    stmts,
    source_file,
    mtime,
    size,
    fully_terminated_line_count,
    last_ok_byte_offset,
    events,
    tool_results,
    batch,
    session_meta,
    source
  } = args;
  const summary = summarizeFile(writableEvents(db, source, source_file, events, batch));
  const cwd = session_meta.cwd;
  const gitBranch = session_meta.git_branch;
  const version = session_meta.version;
  const tx = db.transaction(() => {
    const project_id = deriveProjectId(source, source_file, cwd);
    stmts.upsertProject.run({
      id: project_id,
      // A subagent may work in another directory (a worktree, a subfolder);
      // letting it set the project's cwd made the value depend on which
      // file was read last.
      cwd: SUBAGENT_FILE_RE.test(source_file) ? null : cwd,
      display: project_id
    });
    const kind = deriveSessionKind({
      source_file,
      any_sidechain: summary.any_sidechain,
      cwd,
      recorded: session_meta.kind
    });
    for (const session_id of summary.affected_sessions) {
      stmts.upsertSession.run({
        id: session_id,
        project_id,
        kind,
        parent_id: session_meta.parent_id !== void 0 && session_meta.parent_id !== session_id ? session_meta.parent_id : null,
        started_at: summary.earliest_ts,
        ended_at: summary.latest_ts,
        cwd,
        git_branch: gitBranch,
        model_primary: summary.primary_model,
        version,
        source
      });
    }
    const known = knownTokens(stmts, summary.affected_sessions);
    wipeSessions(stmts, summary.affected_sessions);
    const dropped = stmts.sessionsOnlyInFile.all(source_file).map((r) => r.session_id).filter((sid) => !summary.affected_sessions.has(sid));
    wipeSessions(stmts, dropped);
    for (const sid of dropped) stmts.deleteSession.run(sid);
    const bySession = /* @__PURE__ */ new Map();
    for (const p of summary.events) {
      const arr = bySession.get(p.event.session_id) ?? [];
      arr.push(p);
      bySession.set(p.event.session_id, arr);
    }
    for (const [, list] of bySession) {
      assignTurnNumbers(list);
      for (const p of list) writeParsedEvent(stmts, p, known);
    }
    applyToolResults(stmts, tool_results, [...summary.affected_sessions]);
    flushAnomalyBatch(stmts, batch);
    upsertCursor(db, {
      path: source_file,
      mtime,
      size,
      lines: fully_terminated_line_count,
      last_ok: last_ok_byte_offset
    });
  });
  tx();
  return { eventsInserted: summary.events.length };
}
function writableEvents(db, source, source_file, events, batch) {
  if (source !== "claude" || events.length === 0) return events;
  const skip = (kind, n) => {
    if (n === 0) return;
    const cur = batch.counters.get(kind);
    if (cur) cur.count += n;
    else batch.counters.set(kind, { count: n, detail: null });
  };
  if (SUBAGENT_FILE_RE.test(source_file)) {
    const own2 = events.filter((p) => p.event.agent_id !== null && p.event.session_id === agentSessionId(p.event.agent_id));
    skip("subagent_line_skipped", events.length - own2.length);
    return own2;
  }
  const own = events[events.length - 1].event.session_id;
  const hasRows = db.prepare("SELECT 1 FROM event WHERE session_id = ? LIMIT 1");
  const indexed = /* @__PURE__ */ new Map();
  const kept2 = events.filter((p) => {
    const sid = p.event.session_id;
    if (sid === own) return true;
    if (!indexed.has(sid)) indexed.set(sid, hasRows.get(sid) !== void 0);
    return !indexed.get(sid);
  });
  skip("copied_session_line_skipped", events.length - kept2.length);
  return kept2;
}
var FTS_OPTIMIZE_INTERVAL_MS = 60 * 60 * 1e3;
function optimizeFtsIfDue(db, now, rebuilt, vacuumMinFreeBytes) {
  const last = db.prepare("SELECT value FROM maintenance WHERE key = 'fts_optimized_at'").get();
  if (!rebuilt && last && now - Number(last.value) < FTS_OPTIMIZE_INTERVAL_MS) return;
  const tables = ["user_text_fts", "user_text_fts_trigram", ...listKnownLanguageCodes().map(languageFtsTable)];
  db.transaction(() => {
    for (const t of tables) db.exec(`INSERT INTO ${t} (${t}) VALUES ('optimize')`);
    db.prepare(
      "INSERT INTO maintenance (key, value) VALUES ('fts_optimized_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(now));
  })();
  vacuumIfLoose(db, vacuumMinFreeBytes);
}
var VACUUM_MIN_FREE_BYTES = 100 * 1024 * 1024;
function vacuumIfLoose(db, minFreeBytes) {
  const free = db.pragma("freelist_count", { simple: true }) * db.pragma("page_size", { simple: true });
  if (free >= minFreeBytes) {
    try {
      db.exec("VACUUM");
    } catch (err) {
      console.error("clens: VACUUM failed:", err.message);
    }
  }
  const busyTimeout = db.pragma("busy_timeout", { simple: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma(`busy_timeout = ${busyTimeout}`);
}
async function runIndex(opts = {}) {
  await ensureLanguageAdaptersLoaded();
  const lockTimeoutMs = opts.lockTimeoutMs ?? 3e4;
  const lock = { lost: null };
  const release = await acquireLock(indexLockPath(), lockTimeoutMs, (err) => {
    lock.lost = err;
  });
  const t0 = Date.now();
  try {
    const db = openIndex();
    try {
      const storedVersion = getSchemaVersion(db);
      if (storedVersion !== null && storedVersion > SCHEMA_VERSION && opts.rebuild !== true) {
        throw new Error(
          `the index was written by a newer clens (schema ${storedVersion}, this clens reads ${SCHEMA_VERSION}); restart the sessions still running the old one`
        );
      }
      const needsRebuild = opts.rebuild === true || storedVersion !== null && storedVersion !== SCHEMA_VERSION;
      const stmts = prepareStatements(db);
      if (needsRebuild) {
        const sources = /* @__PURE__ */ new Map();
        for (const r of db.prepare("SELECT DISTINCT session_id, source_file FROM event").iterate()) {
          const list = sources.get(r.session_id) ?? [];
          list.push(r.source_file ?? "");
          sources.set(r.session_id, list);
        }
        const rederivable = [...sources].filter(([, files]) => files.every((f) => f !== "" && existsSync3(f))).map(([sid]) => sid);
        const anomalyFiles = db.prepare("SELECT DISTINCT source_file FROM anomaly").all();
        const cursorPaths = db.prepare("SELECT path FROM file_cursor").all();
        const dropTx = db.transaction(() => {
          wipeSessions(stmts, rederivable);
          const dropSession = db.prepare("DELETE FROM session WHERE id = ?");
          for (const sid of rederivable) dropSession.run(sid);
          const keptCodex = db.prepare("SELECT id, cwd, project_id FROM session WHERE source = 'codex' AND cwd IS NOT NULL").all();
          const setProject = db.prepare("UPDATE session SET project_id = ? WHERE id = ?");
          for (const s of keptCodex) {
            const id = projectIdOf(s.cwd);
            if (id === s.project_id) continue;
            setProject.run(id, s.id);
            stmts.upsertProject.run({ id, cwd: s.cwd, display: id });
          }
          const dropAnomalies = db.prepare("DELETE FROM anomaly WHERE source_file IS ?");
          for (const { source_file } of anomalyFiles) {
            if (source_file === null || existsSync3(source_file)) dropAnomalies.run(source_file);
          }
          const dropCursor = db.prepare("DELETE FROM file_cursor WHERE path = ?");
          for (const { path } of cursorPaths) if (existsSync3(path)) dropCursor.run(path);
          db.exec(`DELETE FROM schema_version`);
          db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(SCHEMA_VERSION);
        });
        dropTx();
      }
      const now = opts.now ?? Date.now();
      const discovered = discoverFiles(db, {
        forceRebuild: needsRebuild
      });
      let filesParsed = 0;
      let filesAppended = 0;
      let events = 0;
      let parseErrors = 0;
      for (const f of discovered) {
        if (!f.needs_parse) continue;
        await new Promise((r) => setImmediate(r));
        if (lock.lost) {
          throw new Error(`clens index: lost the index lock, stopped: ${lock.lost.message}`);
        }
        try {
          if (!needsRebuild && (f.source === "claude" || f.source === "codex")) {
            const appended = f.source === "claude" ? appendNewLines(db, stmts, f) : appendCodexLines(db, stmts, f);
            if (appended.kind === "appended") {
              filesParsed += 1;
              filesAppended += 1;
              events += appended.events;
              parseErrors += appended.parse_errors;
              continue;
            }
          }
          const body = readFileSync2(f.path, "utf8");
          const batch = {
            counters: /* @__PURE__ */ new Map(),
            session_id: null,
            ts: new Date(Math.floor(f.mtime * 1e3)).toISOString(),
            source_file: f.path
          };
          const codex = f.source === "codex" ? parseCodexFile({ body, source_file: f.path, batch }) : null;
          const parsed = codex?.result ?? getSourceAdapter(f.source).parse({ body, source_file: f.path, batch });
          const skills = codex !== null ? filterCodexSkillCandidates(parsed.events, parsed.session_meta.cwd) : null;
          const { eventsInserted } = commitFile({
            db,
            stmts,
            source_file: f.path,
            mtime: f.mtime,
            size: f.size,
            fully_terminated_line_count: parsed.fully_terminated_line_count,
            last_ok_byte_offset: parsed.last_ok_byte_offset,
            events: parsed.events,
            tool_results: parsed.tool_results,
            batch,
            session_meta: parsed.session_meta,
            source: f.source
          });
          if (codex !== null) {
            keepCodexState(f.path, codex.resume, parsed.last_ok_byte_offset, parsed.fully_terminated_line_count, skills, prefilledCallIds(parsed.events));
          }
          filesParsed += 1;
          events += eventsInserted;
          parseErrors += parsed.anomalies.counters.get("json_parse_error")?.count ?? 0;
        } catch (e) {
          process.stderr.write(`clens index: skipped ${f.path}: ${e instanceof Error ? e.message : String(e)}
`);
        }
      }
      if (filesParsed > 0 && !lock.lost) {
        optimizeFtsIfDue(db, now, needsRebuild, opts.vacuumMinFreeBytes ?? VACUUM_MIN_FREE_BYTES);
      }
      return {
        files_total: discovered.length,
        files_parsed: filesParsed,
        events_inserted: events,
        parse_errors: parseErrors,
        files_appended: filesAppended,
        elapsed_ms: Date.now() - t0
      };
    } finally {
      db.close();
    }
  } finally {
    await release();
  }
}

// src/commands/index_cmd.ts
async function indexCommand(flags) {
  const t0 = Date.now();
  try {
    const result = await runIndex({
      rebuild: flags.rebuild,
      lockTimeoutMs: flags.lockTimeoutMs
    });
    process.stderr.write(
      `clens index: parsed ${result.files_parsed}/${result.files_total} files, ${result.events_inserted} events, ${result.parse_errors} parse_errors, ${result.elapsed_ms}ms
  db: ${indexDbPath()}
`
    );
    return 0;
  } catch (e) {
    const err = e;
    if (err.exitCode) {
      process.stderr.write(`clens index: ${err.message ?? "error"}
`);
      return err.exitCode;
    }
    process.stderr.write(
      `clens index: unexpected error after ${Date.now() - t0}ms: ${err.message ?? e}
`
    );
    return 1;
  }
}

// src/commands/install_cmd.ts
import { execFile, execFileSync } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as dirname3, join as join5 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var KIWI_MODEL_URL = "https://github.com/bab2min/Kiwi/releases/download/v0.23.2/kiwi_model_v0.23.2_base.tgz";
var KIWI_MODEL_TAR_SUBDIR = "models/cong/base";
async function installKorean() {
  const targetDir = languageModelDir("ko");
  const tmp = await mkdtemp(join5(tmpdir(), "clens-kiwi-model-"));
  try {
    const tarPath = join5(tmp, "model.tgz");
    process.stderr.write(`clens install ko: downloading ${KIWI_MODEL_URL}
`);
    const res = await fetch(KIWI_MODEL_URL);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    await writeFile(tarPath, Buffer.from(await res.arrayBuffer()));
    const extractDir = join5(tmp, "extracted");
    await mkdir(extractDir, { recursive: true });
    process.stderr.write(`clens install ko: extracting
`);
    await execFileAsync("tar", ["xzf", tarPath, "-C", extractDir]);
    const modelFilesDir = join5(extractDir, KIWI_MODEL_TAR_SUBDIR);
    await mkdir(targetDir, { recursive: true });
    for (const name of await readdir(modelFilesDir)) {
      await rename(join5(modelFilesDir, name), join5(targetDir, name));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
function linderaInstallArgs(code, dir) {
  const { name, version } = LINDERA_PACKAGES[code];
  return ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", `${name}@${version}`];
}
function npm(args) {
  const beside = process.platform === "win32" ? join5(dirname3(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : join5(dirname3(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const [file, argv] = existsSync4(beside) ? [process.execPath, [beside, ...args]] : [process.platform === "win32" ? "npm.cmd" : "npm", args];
  const shell = process.platform === "win32" && file === "npm.cmd";
  execFileSync(file, shell ? argv.map((a) => `"${a}"`) : argv, { stdio: ["ignore", 2, 2], shell });
}
function linderaInstaller(code) {
  return async () => {
    const dir = languageModelDir(code);
    process.stderr.write(`clens install ${code}: installing ${LINDERA_PACKAGES[code].name} into ${dir}
`);
    await mkdir(dir, { recursive: true });
    npm(linderaInstallArgs(code, dir));
  };
}
var INSTALLERS = {
  ko: installKorean,
  ja: linderaInstaller("ja"),
  zh: linderaInstaller("zh")
};
async function installCommand(flags) {
  const installer = INSTALLERS[flags.lang];
  if (!installer) {
    process.stderr.write(
      `clens install: unsupported language '${flags.lang}' \u2014 one of ${Object.keys(INSTALLERS).join(", ")}.
`
    );
    return 2;
  }
  try {
    await installer();
  } catch (e) {
    const err = e;
    process.stderr.write(`clens install ${flags.lang}: failed: ${err.message ?? e}
`);
    return 1;
  }
  process.stderr.write(`clens install ${flags.lang}: model installed, reindexing...
`);
  let result;
  try {
    result = await runIndex({ rebuild: true });
  } catch (e) {
    const err = e;
    process.stderr.write(
      `clens install ${flags.lang}: failed: the analyzer is installed, but the index rebuild failed: ${err.message ?? e}. Run \`start.mjs index --rebuild\` to rebuild it.
`
    );
    return 1;
  }
  process.stderr.write(
    `clens install ${flags.lang}: done. parsed ${result.files_parsed}/${result.files_total} files, ${result.events_inserted} events, ${result.elapsed_ms}ms. Close every open Claude Code and Codex session and start again to use it.
`
  );
  return 0;
}

// src/commands/mcp_cmd.ts
import { spawn } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join6, dirname as dirname4 } from "node:path";
async function mcpCommand() {
  const serverPath = join6(dirname4(fileURLToPath2(import.meta.url)), "server.js");
  const child = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env: process.env
  });
  return new Promise((resolve3) => {
    child.on("exit", (code) => resolve3(code ?? 1));
  });
}

// src/commands/stats_cmd.ts
import { existsSync as existsSync5 } from "node:fs";
import Database2 from "better-sqlite3";

// src/indexer/digest.ts
import { createHash } from "node:crypto";
var TABLE_ORDER = /* @__PURE__ */ new Map([
  ["schema_version", "v"],
  ["file_cursor", "path"],
  ["project", "id"],
  ["session", "id"],
  // A line copied into a resumed session has rows under the same uuid in
  // each session that holds it, so session_id follows the uuid; without it
  // those rows tie and hash in whatever order they were written.
  ["event", "uuid, session_id"],
  ["event_unknown_block", "event_uuid, session_id, block_index"],
  ["tool_call", "event_uuid, session_id, call_id, name"],
  ["file_op", "event_uuid, session_id, tool, path"],
  ["user_text", "event_uuid, session_id, ts, text"],
  ["skill_call", "event_uuid, session_id, ts, skill"],
  ["agent_call", "event_uuid, session_id, ts, subagent_type"],
  ["slash_command", "event_uuid, session_id, ts, name"],
  ["system_reminder", "event_uuid, session_id, ts, category"],
  ["hook_block", "event_uuid, session_id, ts, hook_event, COALESCE(call_id, '')"],
  ["anomaly", "kind, COALESCE(session_id, ''), ts, count, COALESCE(detail, '')"]
]);
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}
function digestAllTables(db) {
  const out = [];
  for (const [table, order] of TABLE_ORDER) {
    const hasher = createHash("sha256");
    let count = 0;
    const cols = table === "file_cursor" ? "path, mtime, size, lines, last_ok" : "*";
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${order}`).all();
    for (const row of rows) {
      count += 1;
      hasher.update(stableStringify(row));
      hasher.update("\n");
    }
    out.push({ table, row_count: count, sha256: hasher.digest("hex") });
  }
  return out;
}

// src/commands/stats_cmd.ts
function collectBasic(db) {
  const r = (q) => db.prepare(q).get();
  const ev = r("SELECT COUNT(*) AS c FROM event");
  const ses = r("SELECT COUNT(*) AS c FROM session");
  const proj = r("SELECT COUNT(*) AS c FROM project");
  const files = r("SELECT COUNT(*) AS c FROM file_cursor");
  const ano = r("SELECT COALESCE(SUM(count),0) AS c FROM anomaly");
  return {
    events: ev.c,
    sessions: ses.c,
    projects: proj.c,
    files: files.c,
    anomalies: ano.c
  };
}
function statsCommand(flags) {
  if (!existsSync5(indexDbPath())) {
    process.stderr.write(`clens stats: no index at ${indexDbPath()}. Run 'clens index' first.
`);
    return 2;
  }
  const db = new Database2(indexDbPath(), { readonly: true });
  try {
    if (flags.digest) {
      const d = digestAllTables(db);
      process.stdout.write(JSON.stringify({ tables: d }, null, 2) + "\n");
      return 0;
    }
    const s = collectBasic(db);
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return 0;
  } finally {
    db.close();
  }
}

// src/cli.ts
function parse2(argv) {
  const cmd = argv[0] ?? "";
  const flags = /* @__PURE__ */ new Map();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i += 1;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}
function usage() {
  process.stderr.write(
    `clens \u2014 search past Claude Code and Codex sessions

usage:
  clens index [--rebuild] [--lock-timeout <ms>]
  clens install <lang>   (ko, ja, zh)
  clens stats [--digest]
  clens mcp
`
  );
}
async function main() {
  const parsed = parse2(process.argv.slice(2));
  switch (parsed.cmd) {
    case "":
    case "help":
    case "--help":
    case "-h":
      usage();
      return parsed.cmd === "" ? 2 : 0;
    case "index": {
      return indexCommand({
        rebuild: parsed.flags.get("rebuild") === true,
        lockTimeoutMs: numberFlag(parsed.flags, "lock-timeout", 3e4)
      });
    }
    case "install": {
      const lang = parsed.positional[0];
      if (lang === void 0) {
        process.stderr.write("clens install: missing <lang> (e.g. 'ko')\n");
        usage();
        return 2;
      }
      return installCommand({ lang });
    }
    case "stats": {
      return statsCommand({
        digest: parsed.flags.get("digest") === true
      });
    }
    case "mcp": {
      return mcpCommand();
    }
    default:
      process.stderr.write(`clens: unknown command '${parsed.cmd}'
`);
      usage();
      return 2;
  }
}
function numberFlag(flags, name, dflt) {
  const v = flags.get(name);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`clens: fatal: ${err?.message ?? err}
`);
    process.exit(1);
  }
);
