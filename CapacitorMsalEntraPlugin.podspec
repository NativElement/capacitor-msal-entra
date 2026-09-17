require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorMsalEntraPlugin'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/yourorg/capacitor-msal-entra-plugin'
  s.author = 'Your Company'
  s.source = { :git => 'https://github.com/yourorg/capacitor-msal-entra-plugin.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'MSAL', '~> 1.2'
  s.swift_version = '5.1'
end
