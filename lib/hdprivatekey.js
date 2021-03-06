'use strict';


var assert = require('assert');
var buffer = require('buffer');
var _ = require('lodash');

var BN = require('./crypto/bn');
var Base58 = require('./encoding/base58');
var Base58Check = require('./encoding/base58check');
var Hash = require('./crypto/hash');
var Network = require('./networks');
var HDKeyCache = require('./hdkeycache');
var Point = require('./crypto/point');
var PrivateKey = require('./privatekey');
var Random = require('./crypto/random');

var errors = require('./errors');
var hdErrors = errors.HDPrivateKey;
var BufferUtil = require('./util/buffer');
var JSUtil = require('./util/js');

var MINIMUM_ENTROPY_BITS = 128;
var BITS_TO_BYTES = 1/8;
var MAXIMUM_ENTROPY_BITS = 512;


/**
 * Represents an instance of an hierarchically derived private key.
 *
 * More info on https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 *
 * @constructor
 * @param {string|Buffer|Object} arg
 */
function HDPrivateKey(arg) {
  /* jshint maxcomplexity: 10 */
  if (arg instanceof HDPrivateKey) {
    return arg;
  }
  if (!(this instanceof HDPrivateKey)) {
    return new HDPrivateKey(arg);
  }
  if (arg) {
    if (_.isString(arg) || BufferUtil.isBuffer(arg)) {
      if (HDPrivateKey.isValidSerialized(arg)) {
        this._buildFromSerialized(arg);
      } else if (JSUtil.isValidJSON(arg)) {
        this._buildFromJSON(arg);
      } else {
        throw HDPrivateKey.getSerializedError(arg);
      }
    } else {
      if (_.isObject(arg)) {
        this._buildFromObject(arg);
      } else {
        throw new hdErrors.UnrecognizedArgument(arg);
      }
    }
  } else {
    return this._generateRandomly();
  }
}

/**
 * Get a derivated child based on a string or number.
 *
 * If the first argument is a string, it's parsed as the full path of
 * derivation. Valid values for this argument include "m" (which returns the
 * same private key), "m/0/1/40/2'/1000", where the ' quote means a hardened
 * derivation.
 *
 * If the first argument is a number, the child with that index will be
 * derived. If the second argument is truthy, the hardened version will be
 * derived. See the example usage for clarification.
 *
 * @example
 * ```javascript
 * var parent = new HDPrivateKey('xprv...');
 * var child_0_1_2h = parent.derive(0).derive(1).derive(2, true);
 * var copy_of_child_0_1_2h = parent.derive("m/0/1/2'");
 * assert(child_0_1_2h.xprivkey === copy_of_child_0_1_2h);
 * ```
 *
 * @param {string|number} arg
 * @param {boolean?} hardened
 */
HDPrivateKey.prototype.derive = function(arg, hardened) {
  if (_.isNumber(arg)) {
    return this._deriveWithNumber(arg, hardened);
  } else if (_.isString(arg)) {
    return this._deriveFromString(arg);
  } else {
    throw new hdErrors.InvalidDerivationArgument(arg);
  }
};

HDPrivateKey.prototype._deriveWithNumber = function(index, hardened) {
  /* jshint maxstatements: 20 */
  /* jshint maxcomplexity: 10 */
  if (index >= HDPrivateKey.Hardened) {
    hardened = true;
  }
  if (index < HDPrivateKey.Hardened && hardened) {
    index += HDPrivateKey.Hardened;
  }
  var cached = HDKeyCache.get(this.xprivkey, index, hardened);
  if (cached) {
    return cached;
  }

  var indexBuffer = BufferUtil.integerAsBuffer(index);
  var data;
  if (hardened) {
    data = BufferUtil.concat([new buffer.Buffer([0]), this.privateKey.toBuffer(), indexBuffer]);
  } else {
    data = BufferUtil.concat([this.publicKey.toBuffer(), indexBuffer]);
  }
  var hash = Hash.sha512hmac(data, this._buffers.chainCode);
  var leftPart = BN.fromBuffer(hash.slice(0, 32), {size: 32});
  var chainCode = hash.slice(32, 64);

  var privateKey = leftPart.add(this.privateKey.toBigNumber()).mod(Point.getN()).toBuffer({size: 32});

  var derived = new HDPrivateKey({
    network: this.network,
    depth: this.depth + 1,
    parentFingerPrint: this.fingerPrint,
    childIndex: index,
    chainCode: chainCode,
    privateKey: privateKey
  });
  HDKeyCache.set(this.xprivkey, index, hardened, derived);
  return derived;
};

HDPrivateKey.prototype._deriveFromString = function(path) {
  var steps = path.split('/');

  // Special cases:
  if (_.contains(HDPrivateKey.RootElementAlias, path)) {
    return this;
  }
  if (!_.contains(HDPrivateKey.RootElementAlias, steps[0])) {
    throw new hdErrors.InvalidPath(path);
  }
  steps = steps.slice(1);

  var result = this;
  for (var step in steps) {
    var index = parseInt(steps[step]);
    var hardened = steps[step] !== index.toString();
    result = result._deriveWithNumber(index, hardened);
  }
  return result;
};

/**
 * Verifies that a given serialized private key in base58 with checksum format
 * is valid.
 *
 * @param {string|Buffer} data - the serialized private key
 * @param {string|Network=} network - optional, if present, checks that the
 *     network provided matches the network serialized.
 * @return {boolean}
 */
HDPrivateKey.isValidSerialized = function(data, network) {
  return !HDPrivateKey.getSerializedError(data, network);
};

/**
 * Checks what's the error that causes the validation of a serialized private key
 * in base58 with checksum to fail.
 *
 * @param {string|Buffer} data - the serialized private key
 * @param {string|Network=} network - optional, if present, checks that the
 *     network provided matches the network serialized.
 * @return {errors.InvalidArgument|null}
 */
HDPrivateKey.getSerializedError = function(data, network) {
  /* jshint maxcomplexity: 10 */
  if (!(_.isString(data) || BufferUtil.isBuffer(data))) {
    return new hdErrors.UnrecognizedArgument('Expected string or buffer');
  }
  if (!Base58.validCharacters(data)) {
    return new errors.InvalidB58Char('(unknown)', data);
  }
  try {
    data = Base58Check.decode(data);
  } catch (e) {
    return new errors.InvalidB58Checksum(data);
  }
  if (data.length !== HDPrivateKey.DataLength) {
    return new hdErrors.InvalidLength(data);
  }
  if (!_.isUndefined(network)) {
    var error = HDPrivateKey._validateNetwork(data, network);
    if (error) {
      return error;
    }
  }
  return null;
};

HDPrivateKey._validateNetwork = function(data, networkArg) {
  var network = Network.get(networkArg);
  if (!network) {
    return new errors.InvalidNetworkArgument(networkArg);
  }
  var version = data.slice(0, 4);
  if (BufferUtil.integerFromBuffer(version) !== network.xprivkey) {
    return new errors.InvalidNetwork(version);
  }
  return null;
};

HDPrivateKey.fromJSON = HDPrivateKey.fromObject = HDPrivateKey.fromString = function(arg) {
  return new HDPrivateKey(arg);
};

HDPrivateKey.prototype._buildFromJSON = function(arg) {
  return this._buildFromObject(JSON.parse(arg));
};

HDPrivateKey.prototype._buildFromObject = function(arg) {
  /* jshint maxcomplexity: 12 */
  // TODO: Type validation
  var buffers = {
    version: arg.network ? BufferUtil.integerAsBuffer(Network.get(arg.network).xprivkey) : arg.version,
    depth: _.isNumber(arg.depth) ? BufferUtil.integerAsSingleByteBuffer(arg.depth) : arg.depth,
    parentFingerPrint: _.isNumber(arg.parentFingerPrint) ? BufferUtil.integerAsBuffer(arg.parentFingerPrint) : arg.parentFingerPrint,
    childIndex: _.isNumber(arg.childIndex) ? BufferUtil.integerAsBuffer(arg.childIndex) : arg.childIndex,
    chainCode: _.isString(arg.chainCode) ? BufferUtil.hexToBuffer(arg.chainCode) : arg.chainCode,
    privateKey: (_.isString(arg.privateKey) && JSUtil.isHexa(arg.privateKey)) ? BufferUtil.hexToBuffer(arg.privateKey) : arg.privateKey,
    checksum: arg.checksum ? (arg.checksum.length ? arg.checksum : BufferUtil.integerAsBuffer(arg.checksum)) : undefined
  };
  return this._buildFromBuffers(buffers);
};

HDPrivateKey.prototype._buildFromSerialized = function(arg) {
  var decoded = Base58Check.decode(arg);
  var buffers = {
    version: decoded.slice(HDPrivateKey.VersionStart, HDPrivateKey.VersionEnd),
    depth: decoded.slice(HDPrivateKey.DepthStart, HDPrivateKey.DepthEnd),
    parentFingerPrint: decoded.slice(HDPrivateKey.ParentFingerPrintStart,
                                     HDPrivateKey.ParentFingerPrintEnd),
    childIndex: decoded.slice(HDPrivateKey.ChildIndexStart, HDPrivateKey.ChildIndexEnd),
    chainCode: decoded.slice(HDPrivateKey.ChainCodeStart, HDPrivateKey.ChainCodeEnd),
    privateKey: decoded.slice(HDPrivateKey.PrivateKeyStart, HDPrivateKey.PrivateKeyEnd),
    checksum: decoded.slice(HDPrivateKey.ChecksumStart, HDPrivateKey.ChecksumEnd),
    xprivkey: arg
  };
  return this._buildFromBuffers(buffers);
};

HDPrivateKey.prototype._generateRandomly = function(network) {
  return HDPrivateKey.fromSeed(Random.getRandomBuffer(64), network);
};

/**
 * Generate a private key from a seed, as described in BIP32
 *
 * @param {string|Buffer} hexa
 * @param {*} network
 * @return HDPrivateKey
 */
HDPrivateKey.fromSeed = function(hexa, network) {
  /* jshint maxcomplexity: 8 */

  if (JSUtil.isHexaString(hexa)) {
    hexa = BufferUtil.hexToBuffer(hexa);
  }
  if (!Buffer.isBuffer(hexa)) {
    throw new hdErrors.InvalidEntropyArgument(hexa);
  }
  if (hexa.length < MINIMUM_ENTROPY_BITS * BITS_TO_BYTES) {
    throw new hdErrors.InvalidEntropyArgument.NotEnoughEntropy(hexa);
  }
  if (hexa.length > MAXIMUM_ENTROPY_BITS * BITS_TO_BYTES) {
    throw new hdErrors.InvalidEntropyArgument.TooMuchEntropy(hexa);
  }
  var hash = Hash.sha512hmac(hexa, new buffer.Buffer('Bitcoin seed'));

  return new HDPrivateKey({
    network: Network.get(network) || Network.livenet,
    depth: 0,
    parentFingerPrint: 0,
    childIndex: 0,
    privateKey: hash.slice(0, 32),
    chainCode: hash.slice(32, 64)
  });
};

/**
 * Receives a object with buffers in all the properties and populates the
 * internal structure
 *
 * @param {Object} arg
 * @param {buffer.Buffer} arg.version
 * @param {buffer.Buffer} arg.depth
 * @param {buffer.Buffer} arg.parentFingerPrint
 * @param {buffer.Buffer} arg.childIndex
 * @param {buffer.Buffer} arg.chainCode
 * @param {buffer.Buffer} arg.privateKey
 * @param {buffer.Buffer} arg.checksum
 * @param {string=} arg.xprivkey - if set, don't recalculate the base58
 *      representation
 * @return {HDPrivateKey} this
 */
HDPrivateKey.prototype._buildFromBuffers = function(arg) {
  /* jshint maxcomplexity: 8 */
  /* jshint maxstatements: 20 */

  HDPrivateKey._validateBufferArguments(arg);
  Object.defineProperty(this, '_buffers', {
    configurable: false,
    value: arg
  });

  var sequence = [
    arg.version, arg.depth, arg.parentFingerPrint, arg.childIndex, arg.chainCode,
    BufferUtil.emptyBuffer(1), arg.privateKey
  ];
  var concat = buffer.Buffer.concat(sequence);
  if (!arg.checksum || !arg.checksum.length) {
    arg.checksum = Base58Check.checksum(concat);
  } else {
    if (arg.checksum.toString() !== Base58Check.checksum(concat).toString()) {
      throw new errors.InvalidB58Checksum(concat);
    }
  }

  var xprivkey;

  if (!arg.xprivkey) {
    xprivkey = Base58Check.encode(buffer.Buffer.concat(sequence));
  } else {
    xprivkey = arg.xprivkey;
  }

  var privateKey = new PrivateKey(BN.fromBuffer(arg.privateKey));
  var publicKey = privateKey.toPublicKey();
  var size = HDPrivateKey.ParentFingerPrintSize;
  var fingerPrint = Hash.sha256ripemd160(publicKey.toBuffer()).slice(0, size);

  JSUtil.defineImmutable(this, {
    xprivkey: xprivkey,
    network: Network.get(BufferUtil.integerFromBuffer(arg.version)),
    depth: BufferUtil.integerFromSingleByteBuffer(arg.depth),
    privateKey: privateKey,
    publicKey: publicKey,
    fingerPrint: fingerPrint
  });

  var HDPublicKey = require('./hdpublickey');
  var hdPublicKey = new HDPublicKey(this);

  JSUtil.defineImmutable(this, {
    hdPublicKey: hdPublicKey,
    xpubkey: hdPublicKey.xpubkey
  });

  return this;
};

HDPrivateKey._validateBufferArguments = function(arg) {
  var checkBuffer = function(name, size) {
    var buff = arg[name];
    assert(BufferUtil.isBuffer(buff), name + ' argument is not a buffer');
    assert(
      buff.length === size,
      name + ' has not the expected size: found ' + buff.length + ', expected ' + size
    );
  };
  checkBuffer('version', HDPrivateKey.VersionSize);
  checkBuffer('depth', HDPrivateKey.DepthSize);
  checkBuffer('parentFingerPrint', HDPrivateKey.ParentFingerPrintSize);
  checkBuffer('childIndex', HDPrivateKey.ChildIndexSize);
  checkBuffer('chainCode', HDPrivateKey.ChainCodeSize);
  checkBuffer('privateKey', HDPrivateKey.PrivateKeySize);
  if (arg.checksum && arg.checksum.length) {
    checkBuffer('checksum', HDPrivateKey.CheckSumSize);
  }
};

/**
 * Returns the string representation of this private key (a string starting
 * with "xprv..."
 *
 * @return string
 */
HDPrivateKey.prototype.toString = function() {
  return this.xprivkey;
};

/**
 * Returns the console representation of this extended private key.
 * @return string
 */
HDPrivateKey.prototype.inspect = function() {
  return '<HDPrivateKey: ' + this.xprivkey + '>';
};

/**
 * Returns a plain object with a representation of this private key.
 *
 * Fields include:<ul>
 * <li> network: either 'livenet' or 'testnet'
 * <li> depth: a number ranging from 0 to 255
 * <li> fingerPrint: a number ranging from 0 to 2^32-1, taken from the hash of the
 * <li>     associated public key
 * <li> parentFingerPrint: a number ranging from 0 to 2^32-1, taken from the hash
 * <li>     of this parent's associated public key or zero.
 * <li> childIndex: the index from which this child was derived (or zero)
 * <li> chainCode: an hexa string representing a number used in the derivation
 * <li> privateKey: the private key associated, in hexa representation
 * <li> xprivkey: the representation of this extended private key in checksum
 * <li>     base58 format
 * <li> checksum: the base58 checksum of xprivkey
 * </ul>
 *  @return {Object}
 */
HDPrivateKey.prototype.toObject = function toObject() {
  return {
    network: Network.get(BufferUtil.integerFromBuffer(this._buffers.version)).name,
    depth: BufferUtil.integerFromSingleByteBuffer(this._buffers.depth),
    fingerPrint: BufferUtil.integerFromBuffer(this.fingerPrint),
    parentFingerPrint: BufferUtil.integerFromBuffer(this._buffers.parentFingerPrint),
    childIndex: BufferUtil.integerFromBuffer(this._buffers.childIndex),
    chainCode: BufferUtil.bufferToHex(this._buffers.chainCode),
    privateKey: this.privateKey.toBuffer().toString('hex'),
    checksum: BufferUtil.integerFromBuffer(this._buffers.checksum),
    xprivkey: this.xprivkey
  };
};

HDPrivateKey.prototype.toJSON = function toJSON() {
  return JSON.stringify(this.toObject());
};

HDPrivateKey.DefaultDepth = 0;
HDPrivateKey.DefaultFingerprint = 0;
HDPrivateKey.DefaultChildIndex = 0;
HDPrivateKey.DefaultNetwork = Network.livenet;
HDPrivateKey.Hardened = 0x80000000;
HDPrivateKey.RootElementAlias = ['m', 'M', 'm\'', 'M\''];

HDPrivateKey.VersionSize = 4;
HDPrivateKey.DepthSize = 1;
HDPrivateKey.ParentFingerPrintSize = 4;
HDPrivateKey.ChildIndexSize = 4;
HDPrivateKey.ChainCodeSize = 32;
HDPrivateKey.PrivateKeySize = 32;
HDPrivateKey.CheckSumSize = 4;

HDPrivateKey.DataLength = 78;
HDPrivateKey.SerializedByteSize = 82;

HDPrivateKey.VersionStart           = 0;
HDPrivateKey.VersionEnd             = HDPrivateKey.VersionStart + HDPrivateKey.VersionSize;
HDPrivateKey.DepthStart             = HDPrivateKey.VersionEnd;
HDPrivateKey.DepthEnd               = HDPrivateKey.DepthStart + HDPrivateKey.DepthSize;
HDPrivateKey.ParentFingerPrintStart = HDPrivateKey.DepthEnd;
HDPrivateKey.ParentFingerPrintEnd   = HDPrivateKey.ParentFingerPrintStart + HDPrivateKey.ParentFingerPrintSize;
HDPrivateKey.ChildIndexStart        = HDPrivateKey.ParentFingerPrintEnd;
HDPrivateKey.ChildIndexEnd          = HDPrivateKey.ChildIndexStart + HDPrivateKey.ChildIndexSize;
HDPrivateKey.ChainCodeStart         = HDPrivateKey.ChildIndexEnd;
HDPrivateKey.ChainCodeEnd           = HDPrivateKey.ChainCodeStart + HDPrivateKey.ChainCodeSize;
HDPrivateKey.PrivateKeyStart        = HDPrivateKey.ChainCodeEnd + 1;
HDPrivateKey.PrivateKeyEnd          = HDPrivateKey.PrivateKeyStart + HDPrivateKey.PrivateKeySize;
HDPrivateKey.ChecksumStart          = HDPrivateKey.PrivateKeyEnd;
HDPrivateKey.ChecksumEnd            = HDPrivateKey.ChecksumStart + HDPrivateKey.CheckSumSize;

assert(HDPrivateKey.ChecksumEnd === HDPrivateKey.SerializedByteSize);

module.exports = HDPrivateKey;
