import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './src/lib/supabase';
import { prepareNotifications } from './src/services/notifications';

type Person = {
  name: string;
  city: string;
  birthday: string;
  relationshipDate: string;
  [key: string]: unknown;
};

type Workspace = {
  couple: {
    id: string;
    invite_code: string;
    created_by: string;
    created_at: string;
  };
  members: Array<{ user_id: string; member_order: number; joined_at: string }>;
  me: Person;
  partner: Person | null;
  partnerId: string | null;
};

const EMPTY_PERSON: Person = {
  name: '',
  city: '',
  birthday: '',
  relationshipDate: '',
};

function normalizePerson(value: unknown): Person {
  const p = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    ...p,
    name: String(p.name || ''),
    city: String(p.city || ''),
    birthday: String(p.birthday || ''),
    relationshipDate: String(p.relationshipDate || ''),
  };
}

function errorMessage(error: unknown) {
  const message = String((error as { message?: string })?.message || error || '');
  if (/invalid login/i.test(message)) return 'Email o password non corretti.';
  if (/email not confirmed/i.test(message)) return 'Conferma prima l’email ricevuta da Supabase.';
  if (/password/i.test(message) && /least|short/i.test(message)) return 'Scegli una password un po’ più lunga.';
  if (/non valido/i.test(message)) return 'Il codice non è valido. Controllalo e riprova.';
  if (/già completa/i.test(message)) return 'Questa coppia contiene già due account.';
  if (/già collegato/i.test(message)) return 'Questo account è già collegato a una coppia.';
  return message || 'Qualcosa non ha funzionato. Riprova.';
}

async function fetchProfile(userId: string) {
  const { data, error } = await supabase
    .from('nodi_profiles')
    .select('user_id,data,updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizePerson(data.data) : null;
}

async function saveProfile(userId: string, person: Person) {
  const clean = { ...person };
  delete (clean as Record<string, unknown>).avatarUrl;

  const { data, error } = await supabase
    .from('nodi_profiles')
    .upsert(
      {
        user_id: userId,
        data: clean,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('user_id,data,updated_at')
    .single();

  if (error) throw error;
  return normalizePerson(data.data);
}

async function fetchWorkspace(userId: string): Promise<Workspace | null> {
  const { data: membership, error: membershipError } = await supabase
    .from('nodi_couple_members')
    .select('couple_id,member_order,joined_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (!membership) return null;

  const { data: couple, error: coupleError } = await supabase
    .from('nodi_couples')
    .select('id,invite_code,created_by,created_at')
    .eq('id', membership.couple_id)
    .single();

  if (coupleError) throw coupleError;

  const { data: members, error: membersError } = await supabase
    .from('nodi_couple_members')
    .select('user_id,member_order,joined_at')
    .eq('couple_id', membership.couple_id)
    .order('member_order');

  if (membersError) throw membersError;

  const allMembers = members || [];
  const partnerId = allMembers.find((member) => member.user_id !== userId)?.user_id || null;
  const ids = [userId, partnerId].filter(Boolean) as string[];

  const { data: profiles, error: profilesError } = await supabase
    .from('nodi_profiles')
    .select('user_id,data,updated_at')
    .in('user_id', ids);

  if (profilesError) throw profilesError;

  const byId = new Map((profiles || []).map((profile) => [profile.user_id, normalizePerson(profile.data)]));

  return {
    couple,
    members: allMembers,
    me: byId.get(userId) || EMPTY_PERSON,
    partner: partnerId ? byId.get(partnerId) || EMPTY_PERSON : null,
    partnerId,
  };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Person | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [booting, setBooting] = useState(true);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [notificationReady, setNotificationReady] = useState(false);

  const loadEverything = useCallback(async (activeSession: Session) => {
    setLoadingWorkspace(true);
    try {
      const ownProfile = await fetchProfile(activeSession.user.id);
      setProfile(ownProfile);
      if (ownProfile) {
        const nextWorkspace = await fetchWorkspace(activeSession.user.id);
        setWorkspace(nextWorkspace);
      } else {
        setWorkspace(null);
      }
    } catch (error) {
      Alert.alert('Nodi', errorMessage(error));
    } finally {
      setLoadingWorkspace(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) {
        loadEverything(data.session).finally(() => mounted && setBooting(false));
      } else {
        setBooting(false);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        loadEverything(nextSession);
      } else {
        setProfile(null);
        setWorkspace(null);
      }
    });

    const appStateListener = AppState.addEventListener('change', (state) => {
      if (state === 'active') supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });

    prepareNotifications()
      .then((result) => setNotificationReady(result.granted))
      .catch(() => setNotificationReady(false));

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
      appStateListener.remove();
    };
  }, [loadEverything]);

  if (booting) return <LoadingScreen label="Apro il vostro spazio…" />;

  if (!session) {
    return <AuthScreen />;
  }

  if (loadingWorkspace && !profile) {
    return <LoadingScreen label="Sincronizzo Nodi…" />;
  }

  if (!profile) {
    return (
      <ProfileScreen
        userId={session.user.id}
        initialName={String(session.user.user_metadata?.name || '')}
        onSaved={(saved) => {
          setProfile(saved);
          loadEverything(session);
        }}
      />
    );
  }

  if (!workspace) {
    return (
      <PairingScreen
        onChanged={() => loadEverything(session)}
        onSignOut={() => supabase.auth.signOut()}
      />
    );
  }

  if (!workspace.partnerId) {
    return (
      <WaitingScreen
        workspace={workspace}
        onRefresh={() => loadEverything(session)}
        onSignOut={() => supabase.auth.signOut()}
      />
    );
  }

  return (
    <HomeScreen
      workspace={workspace}
      notificationReady={notificationReady}
      onRefresh={() => loadEverything(session)}
      onSignOut={() => supabase.auth.signOut()}
    />
  );
}

function ScreenShell({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff8f7" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Brand() {
  return (
    <View style={styles.brandRow}>
      <View style={styles.logoBubble}>
        <Text style={styles.logoText}>∞</Text>
      </View>
      <View>
        <Text style={styles.brand}>Nodi</Text>
        <Text style={styles.brandSubtitle}>Il vostro spazio, ogni giorno.</Text>
      </View>
    </View>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <SafeAreaView style={[styles.safe, styles.center]}>
      <View style={styles.logoBubbleLarge}>
        <Text style={styles.logoTextLarge}>∞</Text>
      </View>
      <Text style={styles.loadingTitle}>Nodi</Text>
      <ActivityIndicator size="large" color="#b45562" />
      <Text style={styles.muted}>{label}</Text>
    </SafeAreaView>
  );
}

function AuthScreen() {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || password.length < 6) {
      Alert.alert('Nodi', 'Inserisci un’email valida e una password di almeno 6 caratteri.');
      return;
    }

    setBusy(true);
    try {
      if (register) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        if (!data.session) {
          Alert.alert('Controlla la posta', 'Ti ho inviato l’email di conferma. Poi torna qui e accedi.');
          setRegister(false);
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      Alert.alert('Accesso', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenShell>
      <Brand />
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>{register ? 'NUOVO ACCOUNT' : 'BENTORNATO'}</Text>
        <Text style={styles.heroTitle}>{register ? 'Create il vostro Nodi.' : 'Rientra nel vostro spazio.'}</Text>
        <Text style={styles.heroCopy}>
          Questa è la nuova app Android nativa. Gli account e le coppie restano quelli della Nodi originale.
        </Text>
      </View>

      <View style={styles.card}>
        <Field label="Email">
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="nome@email.it"
            placeholderTextColor="#a99191"
            style={styles.input}
          />
        </Field>
        <Field label="Password">
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor="#a99191"
            style={styles.input}
          />
        </Field>

        <PrimaryButton
          label={busy ? 'Attendi…' : register ? 'Crea account' : 'Accedi'}
          disabled={busy}
          onPress={submit}
        />

        <Pressable onPress={() => setRegister((value) => !value)} style={styles.linkButton}>
          <Text style={styles.linkText}>
            {register ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati'}
          </Text>
        </Pressable>
      </View>
    </ScreenShell>
  );
}

function ProfileScreen({
  userId,
  initialName,
  onSaved,
}: {
  userId: string;
  initialName: string;
  onSaved: (person: Person) => void;
}) {
  const [person, setPerson] = useState<Person>({ ...EMPTY_PERSON, name: initialName });
  const [busy, setBusy] = useState(false);

  const patch = (key: keyof Person, value: string) => {
    setPerson((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (!person.name.trim()) {
      Alert.alert('Nodi', 'Scrivi il tuo nome.');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveProfile(userId, { ...person, name: person.name.trim() });
      onSaved(saved);
    } catch (error) {
      Alert.alert('Profilo', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenShell>
      <Brand />
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>01 · IL TUO PROFILO</Text>
        <Text style={styles.heroTitle}>Partiamo da te.</Text>
        <Text style={styles.heroCopy}>Le informazioni saranno condivise solo nello spazio della coppia.</Text>
      </View>

      <View style={styles.card}>
        <Field label="Nome">
          <TextInput value={person.name} onChangeText={(v) => patch('name', v)} style={styles.input} placeholder="Il tuo nome" placeholderTextColor="#a99191" />
        </Field>
        <Field label="Città">
          <TextInput value={person.city} onChangeText={(v) => patch('city', v)} style={styles.input} placeholder="Es. Venezia" placeholderTextColor="#a99191" />
        </Field>
        <Field label="Compleanno (AAAA-MM-GG)">
          <TextInput value={person.birthday} onChangeText={(v) => patch('birthday', v)} style={styles.input} placeholder="1995-01-01" placeholderTextColor="#a99191" />
        </Field>
        <Field label="Insieme dal (AAAA-MM-GG)">
          <TextInput value={person.relationshipDate} onChangeText={(v) => patch('relationshipDate', v)} style={styles.input} placeholder="2024-01-01" placeholderTextColor="#a99191" />
        </Field>
        <PrimaryButton label={busy ? 'Salvo…' : 'Salva e continua'} disabled={busy} onPress={save} />
      </View>
    </ScreenShell>
  );
}

function PairingScreen({
  onChanged,
  onSignOut,
}: {
  onChanged: () => void;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('nodi_create_couple');
      if (error) throw error;
      onChanged();
    } catch (error) {
      Alert.alert('Coppia', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== 6) {
      Alert.alert('Nodi', 'Il codice deve avere 6 caratteri.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('nodi_join_couple', { code_input: normalized });
      if (error) throw error;
      onChanged();
    } catch (error) {
      Alert.alert('Coppia', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenShell>
      <Brand />
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>02 · LA COPPIA</Text>
        <Text style={styles.heroTitle}>Collegate i due account.</Text>
        <Text style={styles.heroCopy}>Usiamo lo stesso collegamento reale già presente nella Nodi originale.</Text>
      </View>

      <View style={styles.segmented}>
        <Pressable onPress={() => setMode('create')} style={[styles.segment, mode === 'create' && styles.segmentActive]}>
          <Text style={[styles.segmentText, mode === 'create' && styles.segmentTextActive]}>Crea codice</Text>
        </Pressable>
        <Pressable onPress={() => setMode('join')} style={[styles.segment, mode === 'join' && styles.segmentActive]}>
          <Text style={[styles.segmentText, mode === 'join' && styles.segmentTextActive]}>Ho un codice</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        {mode === 'create' ? (
          <>
            <Text style={styles.cardTitle}>Create il vostro spazio</Text>
            <Text style={styles.cardCopy}>Genererò un codice di 6 caratteri da mandare al partner.</Text>
            <PrimaryButton label={busy ? 'Creo…' : 'Crea codice'} disabled={busy} onPress={create} />
          </>
        ) : (
          <>
            <Field label="Codice invito">
              <TextInput
                value={code}
                onChangeText={(value) => setCode(value.toUpperCase())}
                autoCapitalize="characters"
                maxLength={6}
                style={[styles.input, styles.codeInput]}
                placeholder="ABC234"
                placeholderTextColor="#a99191"
              />
            </Field>
            <PrimaryButton label={busy ? 'Collego…' : 'Collegami'} disabled={busy} onPress={join} />
          </>
        )}
      </View>

      <SecondaryButton label="Esci dall’account" onPress={onSignOut} />
    </ScreenShell>
  );
}

function WaitingScreen({
  workspace,
  onRefresh,
  onSignOut,
}: {
  workspace: Workspace;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const shareCode = () =>
    Share.share({
      message: `Unisciti al nostro spazio Nodi. Codice: ${workspace.couple.invite_code}`,
    });

  return (
    <ScreenShell>
      <Brand />
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>IN ATTESA DEL PARTNER</Text>
        <Text style={styles.heroTitle}>Mandagli questo codice.</Text>
        <Text style={styles.heroCopy}>Quando il secondo account lo inserisce, premi “Controlla ora”.</Text>
      </View>

      <View style={styles.inviteCard}>
        <Text style={styles.inviteLabel}>CODICE COPPIA</Text>
        <Text style={styles.inviteCode}>{workspace.couple.invite_code}</Text>
        <PrimaryButton label="Condividi codice" onPress={shareCode} />
      </View>

      <SecondaryButton label="Controlla ora" onPress={onRefresh} />
      <SecondaryButton label="Esci dall’account" onPress={onSignOut} />
    </ScreenShell>
  );
}

function HomeScreen({
  workspace,
  notificationReady,
  onRefresh,
  onSignOut,
}: {
  workspace: Workspace;
  notificationReady: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const me = workspace.me.name || 'Tu';
  const partner = workspace.partner?.name || 'Partner';
  const relationshipText = useMemo(() => {
    const date = workspace.me.relationshipDate || workspace.partner?.relationshipDate;
    return date ? `Insieme dal ${date}` : 'Il vostro spazio condiviso';
  }, [workspace]);

  const nextPhase = (feature: string) =>
    Alert.alert(feature, 'Questa sezione arriva nella prossima fase nativa. La base dati è già quella di Nodi.');

  return (
    <ScreenShell>
      <Brand />

      <View style={styles.coupleHero}>
        <Text style={styles.eyebrow}>IL VOSTRO NODI</Text>
        <Text style={styles.coupleNames}>{me} <Text style={styles.heart}>♥</Text> {partner}</Text>
        <Text style={styles.heroCopy}>{relationshipText}</Text>
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, notificationReady ? styles.statusDotOk : styles.statusDotWarn]} />
          <Text style={styles.statusText}>
            {notificationReady ? 'Notifiche Android autorizzate' : 'Notifiche da completare'}
          </Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Il vostro spazio</Text>
      <View style={styles.grid}>
        <HomeTile icon="💬" title="Chat" subtitle="Messaggi e vocali" onPress={() => nextPhase('Chat')} />
        <HomeTile icon="📸" title="Ricordi" subtitle="Foto e momenti" onPress={() => nextPhase('Ricordi')} />
        <HomeTile icon="📅" title="Calendario" subtitle="Date e promemoria" onPress={() => nextPhase('Calendario')} />
        <HomeTile icon="📍" title="Distanza" subtitle="Posizione e incontri" onPress={() => nextPhase('Distanza')} />
        <HomeTile icon="🎵" title="Musica" subtitle="Spotify insieme" onPress={() => nextPhase('Musica')} />
        <HomeTile icon="🐾" title="Pet" subtitle="Il vostro compagno" onPress={() => nextPhase('Pet')} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Fase 1 nativa attiva ✓</Text>
        <Text style={styles.cardCopy}>
          Account, profilo e collegamento coppia usano già il Supabase storico di Nodi. Da qui possiamo portare una funzione alla volta senza perdere i dati.
        </Text>
      </View>

      <SecondaryButton label="Aggiorna dati" onPress={onRefresh} />
      <SecondaryButton label="Esci dall’account" onPress={onSignOut} />
    </ScreenShell>
  );
}

function HomeTile({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
      <Text style={styles.tileIcon}>{icon}</Text>
      <Text style={styles.tileTitle}>{title}</Text>
      <Text style={styles.tileSubtitle}>{subtitle}</Text>
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#fff8f7' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24 },
  page: { padding: 22, paddingBottom: 48, gap: 18 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  logoBubble: {
    width: 50, height: 50, borderRadius: 18, backgroundColor: '#f4d8da',
    alignItems: 'center', justifyContent: 'center',
  },
  logoBubbleLarge: {
    width: 86, height: 86, borderRadius: 30, backgroundColor: '#f4d8da',
    alignItems: 'center', justifyContent: 'center',
  },
  logoText: { fontSize: 29, fontWeight: '700', color: '#9b4351' },
  logoTextLarge: { fontSize: 50, fontWeight: '700', color: '#9b4351' },
  brand: { fontSize: 28, lineHeight: 31, fontWeight: '800', color: '#3a2428' },
  brandSubtitle: { fontSize: 13, color: '#8e7478' },
  loadingTitle: { fontSize: 34, fontWeight: '800', color: '#3a2428' },
  hero: { paddingVertical: 12, gap: 8 },
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 1.4, color: '#b45562' },
  heroTitle: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#342226' },
  heroCopy: { fontSize: 17, lineHeight: 25, color: '#765f63' },
  card: {
    backgroundColor: '#ffffff', borderRadius: 26, padding: 20, gap: 16,
    borderWidth: 1, borderColor: '#f1e1e0',
    shadowColor: '#6f3940', shadowOpacity: 0.07, shadowRadius: 16, shadowOffset: { width: 0, height: 7 },
    elevation: 2,
  },
  field: { gap: 7 },
  label: { fontSize: 15, fontWeight: '700', color: '#594247' },
  input: {
    minHeight: 54, borderRadius: 16, borderWidth: 1, borderColor: '#ead8d7',
    backgroundColor: '#fffafa', paddingHorizontal: 16, fontSize: 17, color: '#342226',
  },
  codeInput: { textAlign: 'center', fontSize: 25, fontWeight: '800', letterSpacing: 5 },
  primaryButton: {
    minHeight: 56, borderRadius: 18, backgroundColor: '#aa4d5b',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18,
  },
  primaryButtonText: { fontSize: 17, fontWeight: '800', color: '#ffffff' },
  secondaryButton: {
    minHeight: 52, borderRadius: 18, borderWidth: 1, borderColor: '#e2c9c9',
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fffdfc',
  },
  secondaryButtonText: { fontSize: 16, fontWeight: '700', color: '#80535b' },
  linkButton: { paddingVertical: 5, alignItems: 'center' },
  linkText: { color: '#a24b58', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  muted: { color: '#897276', fontSize: 15 },
  segmented: {
    flexDirection: 'row', padding: 5, borderRadius: 18, backgroundColor: '#f0dfdf', gap: 5,
  },
  segment: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  segmentActive: { backgroundColor: '#ffffff' },
  segmentText: { fontWeight: '700', color: '#8c7175' },
  segmentTextActive: { color: '#8f3f4b' },
  cardTitle: { fontSize: 21, fontWeight: '800', color: '#39272b' },
  cardCopy: { fontSize: 16, lineHeight: 23, color: '#796267' },
  inviteCard: {
    borderRadius: 28, padding: 24, gap: 14, alignItems: 'center',
    backgroundColor: '#f7e1e2', borderWidth: 1, borderColor: '#eccdce',
  },
  inviteLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 1.5, color: '#9b5360' },
  inviteCode: { fontSize: 40, fontWeight: '900', letterSpacing: 8, color: '#6e303a' },
  coupleHero: {
    borderRadius: 30, backgroundColor: '#f6dfe1', padding: 22, gap: 8,
    borderWidth: 1, borderColor: '#edcfd2',
  },
  coupleNames: { fontSize: 31, lineHeight: 38, fontWeight: '900', color: '#3a2529' },
  heart: { color: '#b7505e' },
  statusPill: {
    marginTop: 7, alignSelf: 'flex-start', flexDirection: 'row', gap: 8,
    alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.72)',
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotOk: { backgroundColor: '#54a36d' },
  statusDotWarn: { backgroundColor: '#d49a3e' },
  statusText: { fontSize: 13, fontWeight: '700', color: '#6a5155' },
  sectionTitle: { fontSize: 22, fontWeight: '900', color: '#3a272b', marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: {
    width: '48%', minHeight: 144, backgroundColor: '#ffffff', borderRadius: 24,
    padding: 17, borderWidth: 1, borderColor: '#f0dfdf', justifyContent: 'flex-end',
  },
  tileIcon: { fontSize: 28, marginBottom: 14 },
  tileTitle: { fontSize: 19, fontWeight: '800', color: '#3b282c' },
  tileSubtitle: { fontSize: 13, lineHeight: 18, color: '#8a7175', marginTop: 3 },
});
