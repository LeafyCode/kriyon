package com.leafycode.kriyon.nativemodule

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Rust's JSON as plain values for JavaScript, as it is: maps, lists, null. */
fun parsed(text: String): Any? = plain(JSONTokener(text).nextValue())

/** Rust's JSON object as an event's body; anything else is empty. */
fun objectOf(text: String): Map<String, Any?> =
  try {
    @Suppress("UNCHECKED_CAST")
    parsed(text) as? Map<String, Any?> ?: emptyMap()
  } catch (_: Exception) {
    emptyMap()
  }

private fun plain(value: Any?): Any? =
  when (value) {
    JSONObject.NULL, null -> null
    is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
    is JSONArray -> List(value.length()) { plain(value.get(it)) }
    else -> value
  }
