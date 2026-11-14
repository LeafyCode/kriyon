package com.leafycode.kriyon.nativemodule

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals with an AES key kept in the Android Keystore: made on this phone,
 * never readable by the app and never leaving the phone. It opens only
 * while the phone is unlocked, as the iPhone's keychain item
 * (the spec's choice): nothing reads it while locked, and a start the
 * system made then is tried again when the app comes to the front.
 */
class KeystoreSealer : Sealer {
  private val alias = "kriyon-phone-store"

  /** Looked up (or made) once: each Keystore lookup is a call to another process. */
  private val key: SecretKey by lazy { found() ?: made() }

  private fun found(): SecretKey? =
    KeyStore.getInstance(KEYSTORE).apply { load(null) }.getKey(alias, null) as? SecretKey

  /**
   * Whether the sealing key is there. When it isn't but sealed values are
   * (the Keystore was reset), those values can never be opened again.
   */
  fun hasKey(): Boolean = found() != null

  private fun made(): SecretKey {
    val spec =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        // Android 9 and up only (the app's minSdk is 28).
        .setUnlockedDeviceRequired(true)
        .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
      .apply { init(spec) }
      .generateKey()
  }

  /** The nonce the Keystore chose, then the sealed value. */
  override fun seal(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
    return cipher.iv + cipher.doFinal(plain)
  }

  override fun open(sealed: ByteArray): ByteArray {
    require(sealed.size > NONCE) { "too short to be sealed" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, NONCE))
    return cipher.doFinal(sealed, NONCE, sealed.size - NONCE)
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val NONCE = 12
    const val TAG_BITS = 128
  }
}
