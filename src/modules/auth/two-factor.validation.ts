import { z } from 'zod';

const code = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');
const recoveryCode = z.string().trim().min(8).max(20);

// A second factor is either the app code or one recovery code, never both and never neither.
const exactlyOne = (input: { code?: string | undefined; recoveryCode?: string | undefined }) =>
  (input.code === undefined) !== (input.recoveryCode === undefined);
const oneFactor = { message: 'Send either code or recoveryCode', path: ['code'] };

export const twoFactorSetupSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export const twoFactorEnableSchema = z.object({ code }).strict();
export const twoFactorDisableSchema = z
  .object({ password: z.string().min(1).max(128), code: code.optional(), recoveryCode: recoveryCode.optional() })
  .strict()
  .refine(exactlyOne, oneFactor);
export const twoFactorRecoveryCodesSchema = z.object({ password: z.string().min(1).max(128), code }).strict();
export const twoFactorLoginSchema = z
  .object({ challengeToken: z.string().min(1).max(2000), code: code.optional(), recoveryCode: recoveryCode.optional() })
  .strict()
  .refine(exactlyOne, oneFactor);

export type TwoFactorSetupInput = z.infer<typeof twoFactorSetupSchema>;
export type TwoFactorEnableInput = z.infer<typeof twoFactorEnableSchema>;
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableSchema>;
export type TwoFactorRecoveryCodesInput = z.infer<typeof twoFactorRecoveryCodesSchema>;
export type TwoFactorLoginInput = z.infer<typeof twoFactorLoginSchema>;
