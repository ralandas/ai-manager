import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db/index.js';

/**
 * Owner accounts: register/login by email or phone + password. Sessions are
 * stateless JWTs signed with JWT_SECRET; the token carries the user id.
 */

export interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

const TOKEN_TTL = '30d';

function normEmail(e?: string): string | null {
  return e ? e.trim().toLowerCase() : null;
}
function normPhone(p?: string): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits || null;
}

export async function register(input: {
  email?: string;
  phone?: string;
  password: string;
  name?: string;
}): Promise<{ token: string; user: UserRow }> {
  const email = normEmail(input.email);
  const phone = normPhone(input.phone);
  if (!email && !phone) throw new Error('Нужен email или телефон');
  if (!input.password || input.password.length < 6)
    throw new Error('Пароль минимум 6 символов');

  // Uniqueness check (friendly error instead of raw constraint).
  const clash = await sql<{ id: string }[]>`
    SELECT id FROM users
    WHERE (${email}::text IS NOT NULL AND email = ${email})
       OR (${phone}::text IS NOT NULL AND phone = ${phone})
    LIMIT 1`;
  if (clash.length) throw new Error('Пользователь с таким email/телефоном уже есть');

  const hash = await bcrypt.hash(input.password, 10);
  const rows = await sql<UserRow[]>`
    INSERT INTO users (email, phone, password_hash, name)
    VALUES (${email}, ${phone}, ${hash}, ${input.name ?? null})
    RETURNING id, email, phone, name`;
  const user = rows[0]!;
  return { token: signToken(user.id), user };
}

export async function login(input: {
  login: string; // email or phone
  password: string;
}): Promise<{ token: string; user: UserRow }> {
  const email = normEmail(input.login);
  const phone = normPhone(input.login);
  const rows = await sql<(UserRow & { password_hash: string })[]>`
    SELECT id, email, phone, name, password_hash FROM users
    WHERE email = ${email} OR phone = ${phone}
    LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error('Неверный логин или пароль');
  const ok = await bcrypt.compare(input.password, row.password_hash);
  if (!ok) throw new Error('Неверный логин или пароль');
  const user: UserRow = { id: row.id, email: row.email, phone: row.phone, name: row.name };
  return { token: signToken(user.id), user };
}

export function signToken(userId: string): string {
  return jwt.sign({ uid: userId }, config.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): string | null {
  try {
    const p = jwt.verify(token, config.JWT_SECRET) as { uid: string };
    return p.uid;
  } catch {
    return null;
  }
}

/** Fastify guard: resolves the current user id from the Bearer token or 401s. */
export function authUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const uid = token ? verifyToken(token) : null;
  if (!uid) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return uid;
}
