import { PersonaInfo } from "../types/index.js";
import { Avatar } from "./Avatar.js";
import { FlagQueue } from "../utils/FlagQueue.js";
import type { InWorldSession } from "../client/InWorldSession.js";

export interface PersonaTransform {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface PositionUniversal {
  pParent: { twObjectIx: number; wClass: number };
  pRelative: { vPosition: { dX: number; dY: number; dZ: number } };
}

/**
 * PersonaPuppet - avatar controller that drives the rPersona via Send() calls.
 * Integrates with @metaversalcorp/mvrp RPersona protocol for avatar animation
 * and world interaction.
 */
export class PersonaPuppet extends Avatar {
  private flagQueue: FlagQueue;
  private transform: PersonaTransform = { x: 0, y: 0, z: 0, rotY: 0 };
  private readonly inWorldSession: InWorldSession | null;

  constructor(personaInfo: PersonaInfo, inWorldSession: InWorldSession | null = null) {
    super(personaInfo);
    this.flagQueue = new FlagQueue();
    this.inWorldSession = inWorldSession;
  }

  async spawn(): Promise<void> {
    if (this._spawned) return;

    // Real call (requires @metaversalcorp/mvrp at runtime):
    // const { RPersona } = await import('@metaversalcorp/mvrp');
    // this.rPersona = new RPersona({ personaId: this.personaId });
    // await (this.rPersona as RPersona).spawn(this.transform);

    this._spawned = true;
    console.log(`[PersonaPuppet] Spawned persona ${this.personaId} as "${this.displayName}"`);
  }

  async despawn(): Promise<void> {
    if (!this._spawned) return;

    this.flagQueue.clear();

    // Real call (requires @metaversalcorp/mvrp at runtime):
    // this.getRPersona()?.Send({ type: 'despawn' });
    this._spawned = false;

    console.log(`[PersonaPuppet] Despawned persona ${this.personaId}`);
  }

  /**
   * Move the avatar to a new world position and transmit it to the service.
   * @param positionUniversal - POSITION_UNIVERSAL with pParent and pRelative coordinates.
   */
  moveTo(positionUniversal: PositionUniversal): void {
    if (!this._spawned) return;
    this.transform = {
      x: positionUniversal.pRelative.vPosition.dX,
      y: positionUniversal.pRelative.vPosition.dY,
      z: positionUniversal.pRelative.vPosition.dZ,
      rotY: 0,
    };
    console.log(`[PersonaPuppet] moveTo`, positionUniversal);
    this.sendUpdate(String(positionUniversal.pParent.twObjectIx));
  }

  /**
   * Encode current avatar position/rotation and send an UPDATE to the persona service.
   * Calls rPersona.Send('UPDATE', ...) with position and rotation state.
   */
  sendUpdate(celestialId: string = '104'): void {
    if (!this._spawned) return;

    const rPersona = this.getRPersona();
    if (!rPersona?.Send) return;

    const tmStamp = Date.now();
    const sinHalf = Math.sin(this.transform.rotY / 2);
    const cosHalf = Math.cos(this.transform.rotY / 2);
    const rotDwV = rPersona.Quat_Encode([0, sinHalf, 0, cosHalf]);

    if (typeof rotDwV !== 'number' || isNaN(rotDwV)) {
      console.warn('[PersonaPuppet] Quat_Encode returned invalid value:', rotDwV, ', skipping sendUpdate');
      return;
    }

    rPersona.Send('UPDATE', {
      tmStamp,
      pState: {
        pPosition_Head: {
          pParent: { twObjectIx: celestialId, wClass: 0 },
          pRelative: {
            vPosition: {
              dX: this.transform.x,
              dY: this.transform.y,
              dZ: this.transform.z,
            },
          },
        },
        pRotation_Head: { dwV: rotDwV },
        pRotation_Body: { dwV: rotDwV },
      },
    });
  }

  /**
   * Trigger an avatar animation by name.
   * Calls rPersona.Send() with animation flag.
   */
  playAnimation(animationName: string): void {
    if (!this._spawned) return;

    this.flagQueue.enqueue(animationName);

    // Real call (requires @metaversalcorp/mvrp at runtime):
    // (this.rPersona as RPersona).Send({ type: 'animate', animation: animationName });
    console.log(`[PersonaPuppet] playAnimation "${animationName}"`);
  }

  /**
   * Stop a playing animation.
   */
  stopAnimation(animationName: string): void {
    if (!this._spawned) return;

    this.flagQueue.dequeue(animationName);

    // Real call (requires @metaversalcorp/mvrp at runtime):
    // (this.rPersona as RPersona).Send({ type: 'stopAnimation', animation: animationName });
    console.log(`[PersonaPuppet] stopAnimation "${animationName}"`);
  }

  getTransform(): PersonaTransform {
    return { ...this.transform };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRPersona(): any {
    return this.inWorldSession?.personaSession?.pRPersona;
  }
}
