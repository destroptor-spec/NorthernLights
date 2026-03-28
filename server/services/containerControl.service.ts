import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

// Detect available container runtime (prefer podman, fallback to docker)
let containerRuntime: 'podman' | 'docker' | null = null;
try {
  execSync('podman --version', { stdio: 'ignore' });
  containerRuntime = 'podman';
} catch {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    containerRuntime = 'docker';
  } catch {
    containerRuntime = null;
  }
}

export interface ContainerConfig {
  name: string;
  image: string;
  environment?: Record<string, string>;
  ports?: Record<string, string>;
  volumes?: Record<string, string>;
  restartPolicy?: 'no' | 'always' | 'on-failure';
}

export interface ContainerStatus {
  status: 'running' | 'stopped' | 'not_found' | 'error';
  name: string;
  image?: string;
  created?: string;
  ports?: string;
  error?: string;
}

export interface ContainerListItem {
  name: string;
  status: string;
  image: string;
  ports: string;
  created: string;
}

export interface CreateResult {
  status: 'created' | 'started' | 'error';
  message: string;
  error?: string;
  errorCode?: 'port_in_use' | 'image_not_found' | 'container_exists' | 'not_found' | 'unknown';
}

function getContainerName(config: ContainerConfig, useEnv = true): string {
  return useEnv && config.name === 'music-postgres' 
    ? process.env.DB_CONTAINER_NAME || 'music-postgres'
    : config.name;
}

function getDataDir(): string {
  return process.env.DB_DATA_DIR || './postgres-data';
}

function getDefaultPort(): string {
  return process.env.DB_PORT || '5432';
}

async function runContainer(args: string[], timeout = 60000): Promise<string> {
  if (!containerRuntime) {
    throw new Error('No container runtime found. Install Podman or Docker.');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(containerRuntime!, args);
    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${containerRuntime} command timed out after ` + timeout + 'ms'));
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout);
      } else {
        const errorMsg = stderr || stdout || 'Unknown error';
        if (errorMsg.includes('Conflict') || errorMsg.includes('port is already allocated')) {
          const err = new Error('port_in_use');
          (err as any).stderr = errorMsg;
          reject(err);
        } else if (errorMsg.includes('image does not exist') || errorMsg.includes('not found')) {
          const err = new Error('image_not_found');
          (err as any).stderr = errorMsg;
          reject(err);
        } else if (errorMsg.includes('already exists')) {
          const err = new Error('container_exists');
          (err as any).stderr = errorMsg;
          reject(err);
        } else {
          reject(new Error(errorMsg.substring(0, 500)));
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

export async function getContainerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const output = await runContainer(['ps', '-a', '--format', 'json', '--filter', `name=${containerName}`]);
    
    // Extract the JSON array from potential stdout noise/warnings
    const trimmed = output.trim();
    if (!trimmed) {
      return { status: 'not_found', name: containerName };
    }

    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    
    let jsonStr = '[]';
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = trimmed.substring(firstBracket, lastBracket + 1);
    } else if (trimmed === '[]' || trimmed === '{}') {
      jsonStr = trimmed;
    } else {
      // If we can't find brackets, we might have a single object or garbage
      // Try to parse the trimmed string directly if it looks like JSON
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        jsonStr = '[' + trimmed + ']';
      } else {
        return { status: 'not_found', name: containerName };
      }
    }
    
    let containers: any[];
    try {
      containers = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[ContainerControl] JSON parse failed for output:', trimmed);
      return { status: 'not_found', name: containerName };
    }

    if (!Array.isArray(containers) || containers.length === 0) {
      return { status: 'not_found', name: containerName };
    }

    const container = containers[0];
    const state = (container.State || container.Status || '').toLowerCase();
    const isRunning = state.includes('running') || state.includes('up');
    
    return {
      status: isRunning ? 'running' : 'stopped',
      name: (container.Names && container.Names[0]) || containerName,
      image: container.Image,
      ports: container.Ports ? container.Ports.map((p: any) => `${p.hostPort}:${p.containerPort}`).join(', ') : undefined,
      created: container.Created ? new Date(container.Created * 1000).toISOString() : undefined
    };
  } catch (error: any) {
    return { 
      status: 'error', 
      name: containerName, 
      error: error.message || 'Failed to get container status' 
    };
  }
}

export async function startContainer(containerName: string): Promise<CreateResult> {
  try {
    const status = await getContainerStatus(containerName);
    
    if (status.status === 'not_found') {
      return { status: 'error', message: 'Container not found', errorCode: 'not_found' };
    }
    
    if (status.status === 'running') {
      return { status: 'started', message: `Container ${containerName} is already running` };
    }

    await runContainer(['start', containerName]);
    return { status: 'started', message: `Container ${containerName} started` };
  } catch (error: any) {
    return { status: 'error', message: error.message, error: error.message };
  }
}

export async function stopContainer(containerName: string): Promise<CreateResult> {
  try {
    const status = await getContainerStatus(containerName);
    
    if (status.status === 'not_found') {
      return { status: 'error', message: 'Container not found', errorCode: 'not_found' };
    }
    
    if (status.status === 'stopped') {
      return { status: 'started', message: `Container ${containerName} is already stopped` };
    }

    await runContainer(['stop', containerName]);
    return { status: 'created', message: `Container ${containerName} stopped` };
  } catch (error: any) {
    return { status: 'error', message: error.message, error: error.message };
  }
}

export async function createContainer(config: ContainerConfig): Promise<CreateResult> {
  const containerName = getContainerName(config);
  const dataDir = path.resolve(process.cwd(), getDataDir());
  const port = getDefaultPort();

  try {
    const status = await getContainerStatus(containerName);
    
    if (status.status === 'running') {
      return { status: 'started', message: `Container ${containerName} is already running` };
    }
    
    if (status.status === 'stopped') {
      await runContainer(['start', containerName]);
      return { status: 'started', message: `Container ${containerName} started` };
    }

    // Create data directory if it doesn't exist
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Build arguments array
    const podmanArgs = ['run', '-d'];
    
    // Restart policy
    if (config.restartPolicy && config.restartPolicy !== 'no') {
      podmanArgs.push(`--restart=${config.restartPolicy}`);
    }

    // Name
    podmanArgs.push('--name', containerName);

    // Ports
    const ports = config.ports || { [port]: port };
    for (const [containerPort, hostPort] of Object.entries(ports)) {
      podmanArgs.push('-p', `${hostPort}:${containerPort}`);
    }

    // Environment variables
    const envVars = config.environment || {};
    for (const [key, val] of Object.entries(envVars)) {
      podmanArgs.push('-e', `${key}=${val}`);
    }

    // Volumes
    const volumes = config.volumes || { [dataDir]: '/var/lib/postgresql/data' };
    for (const [host, container] of Object.entries(volumes)) {
      podmanArgs.push('-v', `${host}:${container}:Z`);
    }

    // Image
    podmanArgs.push(config.image || 'pgvector/pgvector:pg16');

    await runContainer(podmanArgs);
    return { status: 'created', message: `Container ${containerName} created and started` };
  } catch (error: any) {
    const errorMessage = error.message || 'unknown';

    if (errorMessage === 'port_in_use') {
      // Try to detect what's using the port safely
      let currentProcess = 'Unknown';
      try {
        const proc = spawn('ss', ['-tlnp']);
        let output = '';
        proc.stdout.on('data', (d) => output += d.toString());
        await new Promise((resolve) => proc.on('close', resolve));
        
        const line = output.split('\n').find(l => l.includes(`:${port}`));
        if (line) currentProcess = line.trim();
        else {
          // fallback to lsof
          const lproc = spawn('lsof', ['-i', `:${port}`]);
          let loutput = '';
          lproc.stdout.on('data', (d) => loutput += d.toString());
          await new Promise((resolve) => lproc.on('close', resolve));
          currentProcess = loutput.split('\n')[1]?.trim() || 'Unknown';
        }
      } catch {}

      return { 
        status: 'error', 
        message: `Port ${port} is already in use. Choose a different port.`, 
        error: `Port ${port} is already in use by: ${currentProcess}`,
        errorCode: 'port_in_use'
      };
    }

    if (errorMessage === 'image_not_found') {
      return { 
        status: 'error', 
        message: `Image ${config.image} not found`, 
        error: errorMessage,
        errorCode: 'image_not_found'
      };
    }

    return { 
      status: 'error', 
      message: errorMessage, 
      error: error.stderr || errorMessage,
      errorCode: 'unknown'
    };
  }
}

export async function recreateContainer(config: ContainerConfig): Promise<CreateResult> {
  const containerName = getContainerName(config);
  
  try {
    const status = await getContainerStatus(containerName);
    
    if (status.status !== 'not_found') {
      await runContainer(['rm', '-f', containerName]);
    }

    return createContainer(config);
  } catch (error: any) {
    return { 
      status: 'error', 
      message: error.message || 'Failed to recreate container', 
      error: error.message 
    };
  }
}

export async function listContainers(): Promise<ContainerListItem[]> {
  try {
    const output = await runContainer(['ps', '-a', '--format', 'json']);
    
    // Extract the JSON array from potential stdout noise/warnings
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : (output.trim() || '[]');
    
    const containers = JSON.parse(jsonStr);
    if (!Array.isArray(containers)) return [];

    return containers.map(container => {
      return { 
        name: (container.Names && container.Names[0]) || 'unknown', 
        status: container.Status || 'unknown', 
        image: container.Image || 'unknown', 
        ports: container.Ports ? container.Ports.map((p: any) => `${p.hostPort}:${p.containerPort}`).join(', ') : '', 
        created: container.Created ? new Date(container.Created * 1000).toISOString() : '' 
      };
    });
  } catch (error: any) {
    console.error('[ContainerControl] Failed to list containers:', error.message);
    return [];
  }
}

export function getConfiguredDatabaseInfo() {
  const port = getDefaultPort();
  const dataDir = getDataDir();
  return {
    image: 'pgvector/pgvector:pg16',
    dataDir,
    port,
    user: 'musicuser',
    name: process.env.DB_CONTAINER_NAME || 'music-postgres',
    runtime: containerRuntime
  };
}

export async function getPortInUse(): Promise<string | null> {
  const port = getDefaultPort();
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    await runContainer(['port', containerName, port]);
    return port;
  } catch {
    return null;
  }
}