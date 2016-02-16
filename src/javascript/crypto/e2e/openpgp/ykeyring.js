/**
 * @license
 * Copyright 2013 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Implements a key ring that exposes basic key management
 *    features such as generating, searching, importing, exporting keys, etc.
 *    The key ring shall be stored in Chrome's local storage, and shall be
 *    encrypted if the user provides a passphrase.
 */

goog.provide('e2e.openpgp.yKeyRing');

goog.require('e2e');
goog.require('e2e.async.Result');
goog.require('e2e.coname.KeyProvider');
goog.require('e2e.coname.getRealmByEmail');
goog.require('e2e.ext.utils.text');
goog.require('e2e.openpgp.KeyRing');
goog.require('e2e.openpgp.block.factory');
goog.require('goog.array');
goog.require('goog.functions');
goog.require('goog.string');



/**
 * Implements a key ring that exposes basic key management features such as
 * generating, searching, importing, exporting keys, etc. The key ring shall
 * be stored in browser's local storage, and shall be encrypted if the user
 * provides a passphrase.
 * @param {!e2e.openpgp.LockableStorage} lockableStorage persistent
 *    storage mechanism.
 * @extends {e2e.openpgp.KeyRing}
 * @constructor
 */
e2e.openpgp.yKeyRing = function(lockableStorage) {
  goog.base(this, lockableStorage);
};
goog.inherits(e2e.openpgp.yKeyRing, e2e.openpgp.KeyRing);


/**
 * the coname KeyProvider
 * @type {e2e.coname.KeyProvider}
 * @private
 */
e2e.openpgp.yKeyRing.conameKeyProvider_ = null;


/**
 * Creates and initializes the CONAME KeyProvider and KeyRing object with an
 *    unlocked storage.
 * @param {!e2e.openpgp.LockableStorage} lockableStorage persistent
 *    storage mechanism. Storage must already be unlocked, otherwise this method
 *    will return a {@link e2e.openpgp.error.MissingPassphraseError}.
 * @param {string=} opt_keyServerUrl The optional http key server url. If not
 *    specified then only support key operation locally.
 * @return {!goog.async.Deferred.<!e2e.openpgp.KeyRing>} The initialized
 *    keyring.
 * @override
 */
e2e.openpgp.yKeyRing.launch = function(lockableStorage, opt_keyServerUrl) {

  // back to regular KeyRing when opt_keyServerUrl is specified or during tests
  if (opt_keyServerUrl ||
      !Boolean(chrome.runtime.getURL)) {
    return e2e.openpgp.KeyRing.launch(lockableStorage, opt_keyServerUrl);
  }

  var keyRing = new e2e.openpgp.yKeyRing(lockableStorage);
  var returnKeyRing = goog.functions.constant(keyRing);
  return /** @type {!goog.async.Deferred.<!e2e.openpgp.KeyRing>} */ (
      keyRing.initialize().addCallback(function() {
        this.conameKeyProvider_ = new e2e.coname.KeyProvider();
      }, keyRing).addCallback(returnKeyRing));
};


/**
 * Restores serialized data from ECC key backup
 * //@yahoo aligns the uid to email mapping similar to key generation
 * @param {e2e.openpgp.KeyringBackupInfo} data
 *     serialized data to restore
 * @param {string} uid User ID to associate with restored keys.
 * @override
 */
e2e.openpgp.yKeyRing.prototype.restoreKeyring = function(data, uid) {
  // @yahoo aligns the uid to email mapping similar to key generation
  var email = e2e.ext.utils.text.extractValidEmail(uid);
  uid = email === uid ? '<' + email + '>' : uid;
  return goog.base(this, 'restoreKeyring', data, uid);
};


/**
 * Imports a key block to the key ring.
 * //@yahoo aligns the uid to email mapping similar to key generation
 * @param {!e2e.openpgp.block.TransferableKey} keyBlock The key block to
 *     import.
 * @param {!e2e.ByteArray=} opt_passphrase The passphrase to use to
 *     import the key.
 * @return {!goog.async.Deferred<?e2e.openpgp.block.TransferableKey>}
 *     The imported key iff it was imported for all User ID packets,
 *     or null if the key was not imported (e.g. a duplicate key). Invalid keys
 *     will call an errback instead.
 * @override
 */
e2e.openpgp.yKeyRing.prototype.importKey = function(
    keyBlock, opt_passphrase) {

  // @yahoo aligns the uid to email mapping similar to key generation
  keyBlock.processSignatures(); // to populate uids
  var uids = keyBlock.getUserIds();
  keyBlock.getUserIds = function() {
    return goog.array.map(uids, function(uid) {
      var email = e2e.ext.utils.text.extractValidEmail(uid);
      return email === null ? uid : '<' + email + '>';
    });
  };

  return goog.base(this, 'importKey', keyBlock, opt_passphrase);
};


/**
 * Upload the local public keys for the user id
 * @param {string} uid The uid
 * @return {!goog.async.Deferred.<boolean>} True if at least one of the keys
 *     are successfully uploaded according to the specified uids.
 */
e2e.openpgp.yKeyRing.prototype.uploadKeys = function(uid) {
  return this.conameKeyProvider_.importKeys(this.searchKey(uid) || [], uid);
};


/**
 * Searches a public or private key for a User ID asynchronously. The search is
 * first performed locally. If we're searching for public key, then searches
 * and appends the public key from the http key server. Do not import the found
 * key to the local keyring.
 * @param {string} uid User ID to search for, or empty to search all.
 * @param {e2e.openpgp.KeyRing.Type=} opt_type Key type to search for.
 * @return {!e2e.async.Result.<!Array.<!e2e.openpgp.block.TransferableKey>>}
 *    An array of keys for the given User ID or [] if not found.
 * @override
 */
e2e.openpgp.yKeyRing.prototype.searchKeyLocalAndRemote = function(uid,
    opt_type) {
  return this.searchKeyLocalAndRemote_(uid, opt_type);
};


/**
 * Searches a public or private key for a User ID asynchronously. The search is
 * first performed locally. If we're searching for public key, then searches
 * and appends the public key from the http key server. Do not import the found
 * key to the local keyring.
 * @param {string} uid User ID to search for, or empty to search all.
 * @param {e2e.openpgp.KeyRing.Type=} opt_type Key type to search for.
 * @param {boolean=} opt_requireRemoteResponse Whether to throw errors if the
 *      server fails.
 * @return {!e2e.async.Result.<!Array.<!e2e.openpgp.block.TransferableKey>>}
 *    An array of keys for the given User ID or [] if not found.
 * @private
 */
e2e.openpgp.yKeyRing.prototype.searchKeyLocalAndRemote_ = function(uid,
    opt_type, opt_requireRemoteResponse) {

  var email = e2e.ext.utils.text.extractValidEmail(uid);
  var localKeys = (email === null) ?
      this.searchKey(uid, opt_type) :
      this.searchKeysByUidMatcher(function(uid_) {
        return goog.string.caseInsensitiveContains(
            uid_, /** @type {string} */ (email));
      }, opt_type);

  // localKeys could be null if none is found
  if (localKeys === null) {
    localKeys = [];
  }

  // append remote public keys, if any
  if ((opt_type && opt_type === e2e.openpgp.KeyRing.Type.PRIVATE) ||
      this.conameKeyProvider_ === null ||
      goog.string.isEmptySafe(email)) {
    return e2e.async.Result.toResult(localKeys);
  }

  var result = new e2e.async.Result;

  this.conameKeyProvider_.getTrustedPublicKeysByEmail(email).
      addCallbacks(function(pubKeys) {
        if (pubKeys.length === 0) {
          result.callback(localKeys);
          return;
        }

        // De-duplicate keys
        var allKeys = localKeys.concat(pubKeys);
        goog.array.removeDuplicates(allKeys, null, function(key) {
          return key.keyPacket.fingerprint.join(',');
        });
        result.callback(allKeys);

      }, function(err) {
        // in case of any error
        opt_requireRemoteResponse ?
            // let error propagates and fail
            result.errback(err) :
            // STILL proceed with local keys
            result.callback(localKeys);
      });

  return result;
};


/**
 * Obtains a key block corresponding to the given key object or null.
 * @param {!e2e.openpgp.Key} keyObject
 * @return {?e2e.openpgp.block.TransferableKey}
 * @override
 */
e2e.openpgp.yKeyRing.prototype.getKeyBlock = function(keyObject) {
  // Obtains a key block from local keyring
  var localKeyBlock = goog.base(this, 'getKeyBlock', keyObject);

  // always prefer local private key. for public keys, use local if any
  if (keyObject.key.secret || localKeyBlock !== null ||
      !keyObject.serialized || keyObject.serialized.length === 0) {
    return localKeyBlock;
  }

  // in case not present in local, use the serialized one if it is present
  // this serialized blob is fetched from keyserver
  var pubKey = e2e.openpgp.block.factory.
          parseByteArrayTransferableKey(keyObject.serialized);
  pubKey.processSignatures();

  return pubKey;
};


/**
 * Obtains a key block having a key with the given key ID locally and remotely
 * or null.
 * @param {!e2e.ByteArray} keyId
 * @param {boolean=} opt_secret Whether to search the private key ring.
 * @return {e2e.async.Result.<e2e.openpgp.block.TransferableKey>}
 */
e2e.openpgp.yKeyRing.prototype.getKeyBlockByIdLocalAndRemote = function(keyId,
    opt_secret) {
  // Obtains a key block from local keyring
  var localKeyBlock = this.getKeyBlockById(keyId, opt_secret);

  // always prefer local private key. for public keys, use local if any
  if (opt_secret || localKeyBlock !== null) {
    return e2e.async.Result.toResult(localKeyBlock);
  }

  return this.conameKeyProvider_.getVerificationKeysByKeyId(keyId).
      addCallback(function(keys) {
        return keys[0] || null;
      });
};


/**
 * Compare local keys with the remote key provider
 * @param {string} uid The uid for remote sync check
 * @return {!goog.async.Deferred}
 */
e2e.openpgp.yKeyRing.prototype.compareWithRemote = function(uid) {

  // search for the local public keys
  var localKeys = this.searchKey(uid, e2e.openpgp.KeyRing.Type.PUBLIC) || [];

  var email = e2e.ext.utils.text.extractValidEmail(uid);
  if (email === null || e2e.coname.getRealmByEmail(email) === null) {
    return e2e.async.Result.toResult({
      syncManaged: false,
      localOnly: [],
      common: localKeys.map(function(k) {return k.toKeyObject();}),
      remoteOnly: []
    });
  }

  return this.conameKeyProvider_.getTrustedPublicKeysByEmail(email).
      addCallback(function(remoteKeys) {

        var localOnly = goog.array.filter(localKeys, function(l) {
          var lFingerprint = l.keyPacket.fingerprint;
          return goog.array.every(remoteKeys, function(r) {
            return !e2e.compareByteArray(
                lFingerprint, r.keyPacket.fingerprint);
          });
        });

        var common = goog.array.filter(localKeys, function(l) {
          var lFingerprint = l.keyPacket.fingerprint;
          return goog.array.every(localOnly, function(r) {
            return !e2e.compareByteArray(
                lFingerprint, r.keyPacket.fingerprint);
          });
        });

        var remoteOnly = goog.array.filter(remoteKeys, function(l) {
          var lFingerprint = l.keyPacket.fingerprint;
          return goog.array.every(localKeys, function(r) {
            return !e2e.compareByteArray(
                lFingerprint, r.keyPacket.fingerprint);
          });
        });

        return {
          syncManaged: true,
          localOnly: localOnly.map(function(k) {return k.toKeyObject();}),
          common: common.map(function(k) {return k.toKeyObject();}),
          remoteOnly: remoteOnly.map(function(k) {return k.toKeyObject();})
        };

      }, this);
};