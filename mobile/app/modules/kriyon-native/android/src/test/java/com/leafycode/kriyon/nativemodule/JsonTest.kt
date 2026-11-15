package com.leafycode.kriyon.nativemodule

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JsonTest {
  @Test
  fun rustsJsonBecomesPlainValuesAsItIs() {
    val value = parsed(
      """{"hostId":"ab","hostName":null,"mayStart":true,"lastChangeMs":1700000000000,
        "sessions":[{"id":"s1","typing":"you"}],"projects":[]}""",
    )
    assertEquals(
      mapOf(
        "hostId" to "ab",
        "hostName" to null,
        "mayStart" to true,
        "lastChangeMs" to 1700000000000L,
        "sessions" to listOf(mapOf("id" to "s1", "typing" to "you")),
        "projects" to emptyList<Any?>(),
      ),
      value,
    )
  }

  @Test
  fun aBareValueAndNullComeThrough() {
    assertEquals("off", parsed("\"off\""))
    assertEquals(true, parsed("true"))
    assertNull(parsed("null"))
  }

  @Test
  fun anEventBodyIsTheObjectOrEmpty() {
    assertEquals(mapOf("hostId" to "ab"), objectOf("""{"hostId":"ab"}"""))
    assertEquals(emptyMap<String, Any?>(), objectOf("not json"))
    assertEquals(emptyMap<String, Any?>(), objectOf("[1]"))
  }
}
