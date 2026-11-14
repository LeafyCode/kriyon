# The phone's native module: a thin Swift pass-through to the Rust library
# (crates/kriyon-mobile). `scripts/mobile/build-ios.sh` puts the library
# and its generated Swift bindings in ios/Rust before a native build.
# The app's own version, so a release moves both.
package = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'KriyonNative'
  s.version        = package['version']
  s.summary        = "Kriyon's Rust library for the phone app"
  s.description    = "A thin Expo module over Kriyon's Rust library (crates/kriyon-mobile)."
  s.author         = 'Leafy Code International'
  s.homepage       = 'https://github.com/LeafyCode/kriyon'
  s.license        = 'Apache-2.0'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The generated Swift and the C header it calls; the header joins this
  # pod's own module, so nothing outside needs a path to it.
  s.source_files = '*.swift', 'Rust/Generated/*.swift', 'Rust/Generated/*.h'
  s.vendored_frameworks = 'Rust/KriyonMobile.xcframework'
  # iroh watches the network through SystemConfiguration.
  s.frameworks = 'SystemConfiguration'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
