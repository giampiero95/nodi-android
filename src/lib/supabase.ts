import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';

const FALLBACK_URL = 'https://jqypibozvxsdttwjbkfs.supabase.co';
const FALLBACK_KEY = 'sb_publishable_SQqsbjEoKSNUjzAooEQ6Nw_9omLXAHt';

const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL || FALLBACK_URL,
  process.env.EXPO_PUBLIC_SUPABASE_KEY || FALLBACK_KEY,
  {
    auth: {
      storage: secureStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
);
