import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function prepareNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('nodi', {
      name: 'Nodi',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      sound: 'default',
    });
  }

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;

  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }

  if (status !== 'granted') {
    return { granted: false as const, token: null };
  }

  try {
    const nativeToken = await Notifications.getDevicePushTokenAsync();
    return {
      granted: true as const,
      token: String(nativeToken.data || ''),
      type: nativeToken.type,
    };
  } catch {
    // Il token FCM diventerà disponibile appena colleghiamo google-services.json.
    return { granted: true as const, token: null };
  }
}
