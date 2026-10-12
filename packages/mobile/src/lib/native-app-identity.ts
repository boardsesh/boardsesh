import { Platform } from 'react-native';
import { applicationId } from 'expo-application';
import { nativeAppIdentity, nativeAppVariantForApplicationId } from '@boardsesh/shared-schema/native-app-identity';

/** Read the installed binary, so a Metro server cannot change its callback identity. */
export const nativeAppVariant = Platform.OS === 'ios' ? nativeAppVariantForApplicationId(applicationId) : 'production';
export const nativeIdentity = nativeAppIdentity(nativeAppVariant);
