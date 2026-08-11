import { describe, expect, it } from 'vitest';
import {
  assertWindowsSigningEnvironment,
  createWindowsPowerShellEnvironment,
  createWindowsSigningTargets,
  validateAuthenticodeRecords
} from '../../scripts/windows-signing.mjs';

describe('Windows code-signing gate', () => {
  it('starts Windows PowerShell without an inherited PowerShell 7 module path', () => {
    const environment = createWindowsPowerShellEnvironment({
      KEEP: 'preserved',
      PSModulePath: 'PowerShell-7-modules',
      psmodulepath: 'case-variant-must-also-go',
      psmoduleanalysiscachepath: 'shared-cache'
    });

    expect(environment.KEEP).toBe('preserved');
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toBe(false);
  });

  it('requires an explicit certificate source and publisher when enforcement is enabled', () => {
    expect(() => assertWindowsSigningEnvironment({ YOUYU_REQUIRE_CODE_SIGNING: '1' })).toThrow(/CSC_LINK/);
    expect(() =>
      assertWindowsSigningEnvironment({ YOUYU_REQUIRE_CODE_SIGNING: '1', CSC_LINK: 'certificate.pfx' })
    ).toThrow(/YOUYU_WINDOWS_PUBLISHER_NAME/);
    expect(
      assertWindowsSigningEnvironment({
        YOUYU_REQUIRE_CODE_SIGNING: '1',
        WIN_CSC_LINK: 'certificate.pfx',
        YOUYU_WINDOWS_PUBLISHER_NAME: '118 Studio'
      })
    ).toEqual({ required: true, publisherName: '118 Studio' });
    expect(assertWindowsSigningEnvironment({})).toEqual({ required: false, publisherName: undefined });
  });

  it('fails closed when any signing material is present without explicit enforcement', () => {
    for (const [name, value] of [
      ['CSC_LINK', 'certificate.pfx'],
      ['WIN_CSC_LINK', 'certificate.pfx'],
      ['CSC_KEY_PASSWORD', 'secret'],
      ['WIN_CSC_KEY_PASSWORD', 'secret'],
      ['YOUYU_WINDOWS_PUBLISHER_NAME', '118 Studio']
    ]) {
      expect(() => assertWindowsSigningEnvironment({ [name]: value })).toThrow(/YOUYU_REQUIRE_CODE_SIGNING is not 1/);
      expect(() => assertWindowsSigningEnvironment({ YOUYU_REQUIRE_CODE_SIGNING: '0', [name]: value })).toThrow(
        /YOUYU_REQUIRE_CODE_SIGNING is not 1/
      );
    }

    expect(() => assertWindowsSigningEnvironment({ YOUYU_REQUIRE_CODE_SIGNING: 'true' })).toThrow(/either 0 or 1/);
    expect(assertWindowsSigningEnvironment({ CSC_LINK: '  ', YOUYU_REQUIRE_CODE_SIGNING: '0' })).toEqual({
      required: false,
      publisherName: undefined
    });
  });

  it('enumerates the installer, app, probe, and bundled core as explicit signing targets', () => {
    expect(createWindowsSigningTargets('C:/release', '1.2.3', 'in').map((target) => target.role)).toEqual([
      'installer',
      'application',
      'fullscreen-probe',
      'mihomo-core'
    ]);
    expect(createWindowsSigningTargets('C:/release', '1.2.3', 'in')[0].path.replaceAll('\\', '/')).toBe(
      'C:/release/YouYu-1.2.3-x64-in.exe'
    );
  });

  it('requires one valid signer and an RFC3161 timestamp on every target', () => {
    const records = ['installer', 'application', 'fullscreen-probe', 'mihomo-core'].map((role, index) => ({
      role,
      path: `target-${index}.exe`,
      status: 'Valid',
      subject: 'CN=118 Studio, O=118 Studio',
      thumbprint: 'A'.repeat(40),
      timestampSubject: 'CN=DigiCert Timestamp 2022'
    }));

    expect(validateAuthenticodeRecords(records, { expectedPublisher: '118 Studio' })).toEqual({
      signerThumbprint: 'A'.repeat(40),
      targetCount: 4
    });
    expect(() =>
      validateAuthenticodeRecords([{ ...records[0], status: 'NotSigned' }, ...records.slice(1)], {
        expectedPublisher: '118 Studio'
      })
    ).toThrow(/NotSigned/);
    expect(() =>
      validateAuthenticodeRecords([{ ...records[0], timestampSubject: undefined }, ...records.slice(1)], {
        expectedPublisher: '118 Studio'
      })
    ).toThrow(/timestamp/);
    expect(() =>
      validateAuthenticodeRecords([{ ...records[0], thumbprint: 'B'.repeat(40) }, ...records.slice(1)], {
        expectedPublisher: '118 Studio'
      })
    ).toThrow(/same certificate/);
  });

  it('matches the exact updater publisher instead of accepting a subject substring', () => {
    const record = {
      role: 'installer',
      path: 'installer.exe',
      status: 'Valid',
      subject: 'CN=Evil 118 Studio Tools, O=Other Publisher',
      thumbprint: 'A'.repeat(40),
      timestampSubject: 'CN=DigiCert Timestamp 2022'
    };

    expect(() => validateAuthenticodeRecords([record], { expectedPublisher: '118 Studio' })).toThrow(
      /signer does not match/
    );
    expect(() =>
      validateAuthenticodeRecords([{ ...record, subject: 'CN=118 Studio, O=118 Studio' }], {
        expectedPublisher: '118 studio'
      })
    ).toThrow(/signer does not match/);
    expect(
      validateAuthenticodeRecords([{ ...record, subject: 'CN=118 Studio, O=118 Studio' }], {
        expectedPublisher: ' 118 Studio '
      })
    ).toEqual({ signerThumbprint: 'A'.repeat(40), targetCount: 1 });
  });

  it('normalizes DN whitespace, quoting, and escaping while comparing fields exactly', () => {
    const record = {
      role: 'installer',
      path: 'installer.exe',
      status: 'Valid',
      subject: 'CN=118 Studio\\, Inc., O=YouYu Studio, C=CN',
      thumbprint: 'A'.repeat(40),
      timestampSubject: 'CN=DigiCert Timestamp 2022'
    };

    expect(
      validateAuthenticodeRecords([record], {
        expectedPublisher: ' CN="118 Studio, Inc." ; O = YouYu Studio '
      })
    ).toEqual({ signerThumbprint: 'A'.repeat(40), targetCount: 1 });
    expect(() =>
      validateAuthenticodeRecords([record], {
        expectedPublisher: 'CN=118 Studio\\2C Inc., O=Different Studio'
      })
    ).toThrow(/signer does not match/);
  });
});
