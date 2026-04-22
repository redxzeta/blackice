import { createHash, createHmac } from 'node:crypto'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  ExecutionRequestSchema,
  type ExecutionRequest,
  type SignedExecutionRequest,
  SignedExecutionRequestSchema,
  type SigningAdapter,
} from './contracts.js'

const SIGNER_REF_ENV = 'BLACKICE_EXECUTION_SIGNER_REF'
const SIGNING_SECRET_ENV = 'BLACKICE_EXECUTION_SIGNING_SECRET'

export type SigningCredentials = {
  signerRef: string
  secret: string
}

export type SigningCredentialsProvider = {
  getCredentials(): Promise<SigningCredentials>
}

export type SignatureCalculator = {
  signCanonicalRequest(
    canonicalRequest: string,
    credentials: SigningCredentials
  ): Promise<string> | string
}

type CreateSigningAdapterOptions = {
  signerKind?: string
  credentialsProvider?: SigningCredentialsProvider
  signatureCalculator?: SignatureCalculator
}

export class SigningAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningAdapterError'
  }
}

export class EnvironmentSigningCredentialsProvider implements SigningCredentialsProvider {
  async getCredentials(): Promise<SigningCredentials> {
    const signerRef = readRequiredEnv(SIGNER_REF_ENV)
    const secret = readRequiredEnv(SIGNING_SECRET_ENV)

    return {
      signerRef,
      secret,
    }
  }
}

export class HmacSha256SignatureCalculator implements SignatureCalculator {
  signCanonicalRequest(canonicalRequest: string, credentials: SigningCredentials): string {
    return createHmac('sha256', credentials.secret).update(canonicalRequest).digest('hex')
  }
}

export class BackendSigningAdapter implements SigningAdapter {
  private readonly credentialsProvider: SigningCredentialsProvider
  private readonly signatureCalculator: SignatureCalculator

  constructor(options: CreateSigningAdapterOptions = {}) {
    this.credentialsProvider =
      options.credentialsProvider ?? new EnvironmentSigningCredentialsProvider()
    this.signatureCalculator = options.signatureCalculator ?? new HmacSha256SignatureCalculator()
  }

  async signExecutionRequest(request: ExecutionRequest): Promise<SignedExecutionRequest> {
    const normalizedRequest = ExecutionRequestSchema.parse(request)
    const credentials = await this.credentialsProvider.getCredentials()
    const canonicalRequest = canonicalizeExecutionRequest(normalizedRequest)
    const signature = await this.signatureCalculator.signCanonicalRequest(
      canonicalRequest,
      credentials
    )

    return SignedExecutionRequestSchema.parse({
      ...normalizedRequest,
      signerRef: credentials.signerRef,
      signature,
    })
  }
}

export class MockSigningAdapter implements SigningAdapter {
  async signExecutionRequest(request: ExecutionRequest): Promise<SignedExecutionRequest> {
    const normalizedRequest = ExecutionRequestSchema.parse(request)
    const canonicalRequest = canonicalizeExecutionRequest(normalizedRequest)

    return SignedExecutionRequestSchema.parse({
      ...normalizedRequest,
      signerRef: `mock:${normalizedRequest.venue}`,
      signature: `mock:${createHash('sha256').update(canonicalRequest).digest('hex')}`,
    })
  }
}

export function createSigningAdapter(options: CreateSigningAdapterOptions = {}): SigningAdapter {
  const signerKind = (options.signerKind ?? getRuntimeConfig().execution.signerKind).trim()

  switch (signerKind) {
    case 'backend':
      return new BackendSigningAdapter(options)
    case 'mock':
      return new MockSigningAdapter()
    default:
      throw new SigningAdapterError(`Unsupported execution.signerKind: ${signerKind}`)
  }
}

export function canonicalizeExecutionRequest(request: ExecutionRequest): string {
  const normalizedRequest = ExecutionRequestSchema.parse(request)

  return JSON.stringify({
    requestId: normalizedRequest.requestId,
    intentId: normalizedRequest.intentId,
    venue: normalizedRequest.venue,
    marketId: normalizedRequest.marketId,
    side: normalizedRequest.side,
    quantity: normalizedRequest.quantity,
    limitPrice: normalizedRequest.limitPrice ?? null,
    executionMode: normalizedRequest.executionMode,
    submittedAt: normalizedRequest.submittedAt,
  })
}

function readRequiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) {
    throw new SigningAdapterError(`${name} is required for backend signing`)
  }
  return value
}
