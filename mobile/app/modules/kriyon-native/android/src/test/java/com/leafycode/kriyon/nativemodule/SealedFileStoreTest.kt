package com.leafycode.kriyon.nativemodule

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import uniffi.kriyon_mobile.StoreException

private fun flip(byte: Byte) = (byte.toInt() xor 0xff).toByte()

/** Seals by flipping every bit: enough to see nothing is kept as given. */
private class FlipSealer : Sealer {
  var locked = false

  override fun seal(plain: ByteArray) = ByteArray(plain.size) { flip(plain[it]) }

  override fun open(sealed: ByteArray): ByteArray {
    if (locked) throw IllegalStateException("Key user not authenticated")
    return ByteArray(sealed.size) { flip(sealed[it]) }
  }
}

class SealedFileStoreTest {
  private lateinit var dir: File
  private lateinit var sealer: FlipSealer
  private lateinit var store: SealedFileStore

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("store").toFile()
    sealer = FlipSealer()
    store = SealedFileStore(File(dir, "kriyon"), sealer)
  }

  @Test
  fun aValueWrittenReadsBackAndOneNeverWrittenIsNone() {
    store.write("device-key", byteArrayOf(1, 2, 3))
    assertArrayEquals(byteArrayOf(1, 2, 3), store.read("device-key"))
    assertNull(store.read("relay"))
  }

  @Test
  fun aNewValueReplacesTheOld() {
    store.write("relay", byteArrayOf(1))
    store.write("relay", byteArrayOf(2, 2))
    assertArrayEquals(byteArrayOf(2, 2), store.read("relay"))
  }

  @Test
  fun onlySealedBytesReachTheDisk() {
    store.write("device-key", byteArrayOf(1, 2, 3))
    val files = File(dir, "kriyon").listFiles().orEmpty()
    assertTrue(files.isNotEmpty())
    for (file in files) {
      assertFalse(file.readBytes().contentEquals(byteArrayOf(1, 2, 3)))
      assertFalse(file.name.contains("device-key"))
    }
  }

  @Test
  fun removingDropsTheValueAndAMissingOneIsFine() {
    store.write("relay", byteArrayOf(1))
    store.remove("relay")
    assertNull(store.read("relay"))
    store.remove("relay")
  }

  @Test
  fun aValueThatCannotBeOpenedFailsRatherThanReadingAsNone() {
    store.write("device-key", byteArrayOf(1, 2, 3))
    sealer.locked = true
    try {
      store.read("device-key")
      fail("a sealed value that can't be opened must not read as missing")
    } catch (error: StoreException.Failed) {
      assertTrue(error.reason.contains("device-key"))
    }
  }

  @Test
  fun clearingDropsEveryValue() {
    store.write("device-key", byteArrayOf(1))
    store.write("relay", byteArrayOf(2))
    store.clear()
    assertNull(store.read("device-key"))
    assertNull(store.read("relay"))
    // and it can be used again after
    store.write("relay", byteArrayOf(3))
    assertArrayEquals(byteArrayOf(3), store.read("relay"))
  }
}
