# Kept for apps built with R8 (release builds). JNA reaches its classes and
# UniFFI's structures and callbacks by reflection, and refers to desktop
# Java (java.awt) that Android doesn't have and JNA never uses there.
-dontwarn java.awt.**
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class uniffi.kriyon_mobile.** { *; }
