import { StatusBar } from 'expo-status-bar';
import { Image, StyleSheet, Text, View } from 'react-native';

// Bump this string, run `npx expo export`, publish it with the updraft CLI,
// and relaunch the app to watch the update arrive over the air.
const OTA_MESSAGE = 'v1: embedded bundle';

export default function App() {
  return (
    <View style={styles.container}>
      {/* A required asset, so the export exercises asset delivery and not
          just the JS bundle. */}
      <Image source={require('./assets/icon.png')} style={styles.logo} />
      <Text style={styles.title}>Updraft example</Text>
      <Text style={styles.message}>{OTA_MESSAGE}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logo: {
    width: 96,
    height: 96,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  message: {
    fontSize: 16,
    color: '#555',
  },
});
