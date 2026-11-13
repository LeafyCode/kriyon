package com.leafycode.kriyon.nativemodule

import java.io.File
import java.io.FileOutputStream
import uniffi.kriyon_mobile.PhoneStore
import uniffi.kriyon_mobile.StoreException

/** Seals a value so only this phone can open it again. */
interface Sealer {
  fun seal(plain: ByteArray): ByteArray

  /** Throws when it can't open: the key is gone, or the phone is locked. */
  fun open(sealed: ByteArray): ByteArray
}

/**
 * The phone's store for the Rust library: each value sealed by [sealer], one
 * file per key in [dir]. Give it a folder Android never backs up or moves to
 * another phone (`noBackupFilesDir`); the sealing key can't leave it either.
 */
class SealedFileStore(private val dir: File, private val sealer: Sealer) : PhoneStore {
  /** A key's file, named by its bytes in hex so any key is a safe name. */
  private fun file(key: String) =
    File(dir, key.toByteArray().joinToString("") { "%02x".format(it) })

  /** Never null for a value that is there but can't be opened: Rust would start afresh. */
  @Synchronized
  override fun read(key: String): ByteArray? {
    val file = file(key)
    if (!file.exists()) return null
    return failing("read", key) { sealer.open(file.readBytes()) }
  }

  @Synchronized
  override fun write(key: String, value: ByteArray) {
    failing("write", key) {
      dir.mkdirs()
      // Whole or not at all: a new file, then moved over the old one.
      // Synced before the move, so a phone that loses power keeps the old
      // value or the new one, never an empty file.
      val next = File(dir, "${file(key).name}.new")
      FileOutputStream(next).use { out ->
        out.write(sealer.seal(value))
        out.fd.sync()
      }
      if (!next.renameTo(file(key))) error("couldn't replace it")
    }
  }

  @Synchronized
  override fun remove(key: String) {
    failing("remove", key) {
      val file = file(key)
      if (file.exists() && !file.delete()) error("couldn't delete it")
    }
  }

  /**
   * Drop every value. Only for values that can never be opened again (the
   * sealing key is gone): Rust then starts afresh, and the phone pairs again.
   */
  @Synchronized
  fun clear() {
    dir.listFiles()?.forEach { it.delete() }
  }

  private inline fun <T> failing(what: String, key: String, call: () -> T): T =
    try {
      call()
    } catch (error: Exception) {
      throw StoreException.Failed("store $what of $key failed: ${error.message}")
    }
}
