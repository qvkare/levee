// Multicall3 at an exact historic block. Every sub-call may fail on its own.
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from 'viem';
import type { Rpc } from '../rpc.ts';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

export interface Call {
  target: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Returns one decoded value per call, or null where the sub-call failed. */
export async function multicall(rpc: Rpc, block: number, calls: Call[]): Promise<unknown[]> {
  const data = encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: 'aggregate3',
    args: [
      calls.map((call) => ({
        target: call.target as `0x${string}`,
        allowFailure: true,
        callData: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] }),
      })),
    ],
  });
  const raw = await rpc.call<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, '0x' + block.toString(16)]);
  const results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: raw }) as readonly {
    success: boolean;
    returnData: `0x${string}`;
  }[];
  if (results.length !== calls.length) throw new Error(`multicall returned ${results.length}, wanted ${calls.length}`);
  return results.map((result, i) => {
    if (!result.success || result.returnData === '0x') return null;
    const call = calls[i]!;
    try {
      return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: result.returnData });
    } catch {
      return null;
    }
  });
}

export { decodeFunctionData };
