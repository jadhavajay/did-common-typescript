
const elliptic = require('elliptic');
const BN = require('bn.js');
import base64url from 'base64url';
import DidKey from './DidKey';
import { KeyType } from './KeyType';
import { KeyUse } from './KeyUse';
import { BigIntegerStatic } from 'big-integer';
import { KeyExport } from './KeyExport';
const bigInt = require('big-integer');

/**
 * Class to model a pairwise key
 */
export default class PairwiseKey {
  /**
   * Get the index for pairwise key
   */
  private _id: string;

  /**
   * Get the pairwise id
   */
  private _peerId: string;

  /**
   * Get the number of prime tests
   */
  private _numberOfPrimeTests: number;

  /**
   * Get the pairwise key
   */
  private _key: DidKey | undefined;

  /**
   * Buffer used for prime generation
   */
  private _deterministicKey: Buffer = Buffer.from('');
  /**
   * Get the id for the pairwise key
   */
  public get id () {
    return this._id;
  }

  /**
   * Get the id for the pairwise key
   */
  public get key (): DidKey | undefined {
    return this._key;
  }

  /**
   * Get the number of tests needed for prime generation
   */
  public get primeTests (): number {
    return this._numberOfPrimeTests;
  }

  /**
   * Create an instance of PairwiseKey.
   * @param did The DID.
   * @param peerId The peer id.
   */
  constructor (did: string, peerId: string) {
    this._id = `${did}-${peerId}`;
    this._peerId = peerId;
    this._key = undefined;
    this._numberOfPrimeTests = 0;
  }

  /**
   * Generate the pairwise Key.
   * @param didMasterKey The master key for this did.
   * @param crypto The crypto object.
   * @param algorithm Intended algorithm to use for the key.
   * @param keyType Key type.
   * @param keyUse Key usage.
   * @param exportable True if the key is exportable.
   */
  public async generate (
    didMasterKey: Buffer,
    crypto: any,
    algorithm: any,
    keyType: KeyType,
    keyUse: KeyUse, exportable: boolean = true): Promise<DidKey> {
    switch (keyType) {
      case KeyType.EC:
        return this.generateEcPairwiseKey(didMasterKey, crypto, algorithm, keyType, keyUse, exportable);
      case KeyType.RSA:
        return this.generateRsaPairwiseKey(didMasterKey, crypto, algorithm, keyType, keyUse);
    }

    throw new Error(`Pairwise key for key type ${keyType} is not supported`);
  }

  /**
   * Generate a deterministic number that can be used as prime
   * @param crypto The crypto object.
   * @param keySize Desired key size
   * @param didMasterKey The DID masterkey
   * @param peerId The peer id
   */
  public async generateDeterministicNumberForPrime (crypto: any, primeSize: number, didMasterKey: Buffer, peerId: Buffer): Promise<Buffer> {
    let numberOfRounds: number = primeSize / (8 * 64);
    this._deterministicKey = Buffer.from('');
    let rounds: Array<(crypto: any, inx: number, key: Buffer, data: Buffer) => Promise<Buffer>> = [];
    for (let inx = 0; inx < numberOfRounds ; inx++) {
      rounds.push((crypto: any, inx: number, key: Buffer, data: Buffer) => {
        return this.generateHashForPrime(crypto, inx, key, data);
      });
    }

    return this.executeRounds(crypto, rounds, 0, didMasterKey, Buffer.from(peerId));
  }

  /**
   * Generate a hash used as component for prime number
   * @param crypto The crypto object.
   * @param inx Round number
   * @param key Signature key
   * @param data Data to sign
   */
  private async generateHashForPrime (crypto: any, _inx: number, key: Buffer, data: Buffer): Promise<Buffer> {
    const alg = { name: 'hmac', hash: { name: 'SHA-512' } };
    let deterministicNumber = new DidKey(crypto, alg, key, true);
    await deterministicNumber.getJwkKey(KeyExport.Secret);
    let signature = await deterministicNumber.sign(data);
    this._deterministicKey = Buffer.concat([this._deterministicKey, Buffer.from(signature)]);
    return this._deterministicKey;
  }

  /**
   * Execute all rounds
   * @param rounds Array of functions to execute
   * @param inx Current step
   * @param key Key to sign
   * @param data Data to sign
   */
  private async executeRounds (crypto: any, rounds: Array<(crypto: any, inx: number, key: Buffer, data: Buffer) =>
    Promise<Buffer>>, inx: number, key: Buffer, data: Buffer): Promise<Buffer> {
    let signature: Buffer = await rounds[inx](crypto, inx, key, data);
    if (inx + 1 === rounds.length) {
      return this._deterministicKey;
    } else {
      await this.executeRounds(crypto, rounds, inx + 1, key, Buffer.from(signature));
      return this._deterministicKey;
    }
  }

  /**
   * Generate a prime number from the seed.
   * isProbablyPrime is based on the Miller-Rabin prime test.
   * @param primeSeed seed for prime generator
   */
  generatePrime (primeSeed: Array<number>): BigIntegerStatic {
    // make sure candidate is uneven, set high order bit
    primeSeed[primeSeed.length - 1] |= 0x1;
    primeSeed[0] |= 0x80;
    let two = bigInt(2);
    let prime = bigInt.fromArray(primeSeed, 256, false);
    this._numberOfPrimeTests = 1;
    while (true) {
      // 64 tests give 128 bit security
      if (prime.isProbablePrime(64)) {
        break;
      }
      prime = prime.add(two);
      this._numberOfPrimeTests++;
    }

    return prime;
  }

  /**
   * Generate the RSA pairwise Key.
   * @param didMasterKey The master key for this did.
   * @param crypto The crypto object.
   * @param algorithm Intended algorithm to use for the key.
   * @param keyType Key type.
   * @param keyUse Key usage.
   * @param exportable True if the key is exportable.
   */
  private async generateRsaPairwiseKey (
    didMasterKey: Buffer,
    crypto: any,
    algorithm: any,
    keyType: KeyType,
    keyUse: KeyUse): Promise<DidKey> {
      // Generate peer key
    let minimumKeySize = 1024;
    let keySize = minimumKeySize;
    if (algorithm.modulusLength) {
      keySize = algorithm.modulusLength;
    }

    // Get peer id
    let peerId = Buffer.from(this._peerId);

    // Get pbase
    let pBase: Buffer = await this.generateDeterministicNumberForPrime(crypto, keySize / 2, didMasterKey, peerId);
    // Get qbase
    let qBase: Buffer = await this.generateDeterministicNumberForPrime(crypto, keySize / 2, pBase, peerId);
    let p = this.getPrime(pBase);
    let q = this.getPrime(qBase);

          // compute key components
    let modulus = p.multiply(q);
    let pMinus = p.subtract(bigInt.one);
    let qMinus = q.subtract(bigInt.one);
    let phi = pMinus.multiply(qMinus);
    let e = bigInt(65537);
    let d = e.modInv(phi);
    let dp = d.mod(pMinus);
    let dq = d.mod(qMinus);
    let qi = q.modInv(p);
    let jwk = {
      kty: 'RSA',
      use: keyUse.toString(),
      e: this.toBase(e),
      n: this.toBase(modulus),
      d: this.toBase(d),
      p: this.toBase(p),
      q: this.toBase(q),
      dp: this.toBase(dp),
      dq: this.toBase(dq),
      qi: this.toBase(qi)
    };

    return new DidKey(crypto, algorithm, jwk);
  }

  /**
   * Uses primeBase as reference and generate the closest prime number
   */
  private getPrime (primeBase: Buffer): any {
    let qArray = Array.from(primeBase);
    let prime: bigInt.BigIntegerStatic = this.generatePrime(qArray);
    let p = new bigInt(prime);
    return p;
  }

  /**
   * Convert big number to base64 url.
   * @param bigNumber Number to convert
   */
  private toBase (bigNumber: any): string {
    let buf = Buffer.from(bigNumber.toArray(256).value);
    return base64url(buf);
  }

  /**
   * Generate the EC pairwise Key.
   * @param didMasterKey The master key for this did.
   * @param crypto The crypto object.
   * @param algorithm Intended algorithm to use for the key.
   * @param keyType Key type.
   * @param keyUse Key usage.
   * @param exportable True if the key is exportable.
   */
  private async generateEcPairwiseKey (
    didMasterKey: Buffer,
    crypto: any,
    algorithm: any,
    keyType: KeyType,
    keyUse: KeyUse,
    exportable: boolean = true): Promise<DidKey> {
      // Generate peer key
    const alg = { name: 'hmac', hash: { name: 'SHA-256' } };
    let hashDidKey = new DidKey(crypto, alg, didMasterKey, true);
    let signature: any = await hashDidKey.sign(Buffer.from(this._peerId));
    let ec = undefined;
    let curve: string = algorithm.namedCurve;
    switch (algorithm.namedCurve) {
      case 'K-256':
      case 'P-256K':
        ec = new elliptic.ec('secp256k1');
        break;

      default:
        throw new Error(`Curve ${algorithm.namedCurve} is not supported`);
    }

    let privKey = new BN(Buffer.from(signature));
    let pair = ec.keyPair({ priv: privKey });
    let pubKey = pair.getPublic();
    if (!pair.validate()) {
      console.log('failed');
    }

    let d = privKey.toArrayLike(Buffer, 'be', 32);
    let x = pubKey.x.toArrayLike(Buffer, 'be', 32);
    let y = pubKey.y.toArrayLike(Buffer, 'be', 32);
    let jwk = {
      crv: curve,
      d: base64url.encode(d),
      x: base64url.encode(x),
      y: base64url.encode(y),
      kty: 'EC'
    };

    this._key = new DidKey(crypto, algorithm, jwk, exportable);
    return this._key;
  }

}
