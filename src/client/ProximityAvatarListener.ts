import type { ProximityAudioManager } from '../audio/ProximityAudioManager.js';

/**
 * Avatar info with calculated distance for sorting and display.
 */
export interface AvatarInfo {
  personaID: number;
  name: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

/**
 * Listens to MVRP Proximity events to track nearby external avatars.
 * Follows the MVRP notification pattern:
 *   - Implements onModelUpdate, onModelClose, onUserReady callbacks
 *   - Registers with proximity.Attach(this) to receive events
 *   - Proximity calls our methods when avatar events occur
 *   - Calls proximity.Detach(this) to unregister
 */
export class ProximityAvatarListener {
  private avatars: Map<number, AvatarInfo> = new Map();
  private localPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private localPersonaID: number | null = null;
  private observers: Set<(avatars: AvatarInfo[]) => void> = new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private proximity: any = null;

  /**
   * Initialize the proximity tracker and attach to the Proximity instance.
   * Proximity will call our onModelUpdate/onModelClose/onUserReady methods
   * whenever avatar events occur.
   */
  init(audioManager: ProximityAudioManager): void {
    const proximity = audioManager.getProximity();
    if (!proximity) {
      console.warn('[ProximityAvatarListener] Proximity not available');
      return;
    }

    this.proximity = proximity;
    proximity.Attach(this);
    console.log('[ProximityAvatarListener] Attached to Proximity');
  }

  /**
   * Proximity callback: Called when the local avatar is ready in the world.
   * Receives the initial position and persona ID.
   */
  onUserReady(nAvatarIx: number, dwRPersonaIx: number, nX: number, nY: number, nZ: number): void {
    this.localPersonaID = dwRPersonaIx;
    this.localPosition = { x: nX, y: nY, z: nZ };
    console.log('[ProximityAvatarListener] Local avatar ready:', dwRPersonaIx, 'at', nX, nY, nZ);
  }

  /**
   * Proximity callback: Called when a remote avatar's state is updated.
   * This includes position, animation, gesture, etc.
   *
   * @param SBA_RProximity_Avatar_Open_Ex Avatar metadata (name, ID) - only present on first appearance
   * @param dwRPersonaIx The persona ID of the avatar
   * @param MVO_RAvatar_State Current state including position, rotation, etc.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onModelUpdate(SBA_RProximity_Avatar_Open_Ex: any, dwRPersonaIx: number, MVO_RAvatar_State: any): void {
    // Skip the local avatar
    if (dwRPersonaIx === this.localPersonaID) {
      return;
    }

    // SBA_RProximity_Avatar_Open_Ex is only present on the first appearance of an avatar.
    // For subsequent updates, preserve the stored name.
    // If the avatar is not yet tracked and metadata is missing, skip — we cannot identify it.
    let name: string;
    if (SBA_RProximity_Avatar_Open_Ex) {
      const forename = SBA_RProximity_Avatar_Open_Ex.Name?.wszForename ?? '';
      const surname = SBA_RProximity_Avatar_Open_Ex.Name?.wszSurname ?? '';
      name = `${forename} ${surname}`.trim() || `Avatar ${dwRPersonaIx}`;
    } else {
      const existing = this.avatars.get(dwRPersonaIx);
      if (!existing) return;
      name = existing.name;
    }

    const position = MVO_RAvatar_State?.MVO_RPosition_Head;
    if (position) {
      this.updateAvatar(dwRPersonaIx, name, position);
    }
  }

  /**
   * Proximity callback: Called when a remote avatar leaves the proximity.
   */
  onModelClose(dwRPersonaIx: number): void {
    // Skip the local avatar
    if (dwRPersonaIx === this.localPersonaID) {
      return;
    }

    this.removeAvatar(dwRPersonaIx);
  }

  /**
   * Proximity callback: Called when an avatar hides (goes out of range but not fully removed).
   */
  onModelHide(dwRPersonaIx: number): void {
    // For proximity list, treat hide the same as close
    this.removeAvatar(dwRPersonaIx);
  }

  /**
   * Update or add an avatar to the tracking list.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateAvatar(personaID: number, name: string, position: any): void {
    const distance = this.calculateDistance(position);

    this.avatars.set(personaID, {
      personaID,
      name,
      position: { x: position.nX, y: position.nY, z: position.nZ },
      distance,
    });

    console.log('[ProximityAvatarListener] Updated avatar', personaID, name, '(' + distance.toFixed(2) + 'm)');
    this.notifyObservers();
  }

  /**
   * Remove an avatar from tracking.
   */
  private removeAvatar(personaID: number): void {
    const avatar = this.avatars.get(personaID);
    if (avatar) {
      console.log('[ProximityAvatarListener] Removed avatar', personaID, avatar.name);
      this.avatars.delete(personaID);
      this.notifyObservers();
    }
  }

  /**
   * Calculate Euclidean distance from local avatar to remote avatar.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calculateDistance(position: any): number {
    const dx = position.nX - this.localPosition.x;
    const dy = position.nY - this.localPosition.y;
    const dz = position.nZ - this.localPosition.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get the closest avatars, sorted by distance.
   */
  getClosestAvatars(count: number = 5): AvatarInfo[] {
    return Array.from(this.avatars.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);
  }

  /**
   * Update local avatar position for distance calculations.
   */
  setLocalPosition(x: number, y: number, z: number): void {
    this.localPosition = { x, y, z };
    // Recalculate all distances
    for (const avatar of this.avatars.values()) {
      const pos = { nX: avatar.position.x, nY: avatar.position.y, nZ: avatar.position.z };
      avatar.distance = this.calculateDistance(pos);
    }
    this.notifyObservers();
  }

  /**
   * Register an observer to be notified when the avatar list changes.
   */
  addObserver(callback: (avatars: AvatarInfo[]) => void): void {
    this.observers.add(callback);
  }

  /**
   * Unregister an observer.
   */
  removeObserver(callback: (avatars: AvatarInfo[]) => void): void {
    this.observers.delete(callback);
  }

  /**
   * Notify all observers of changes.
   */
  private notifyObservers(): void {
    const closestAvatars = this.getClosestAvatars(5);
    for (const observer of this.observers) {
      observer(closestAvatars);
    }
  }

  /**
   * Clean up and detach from Proximity.
   */
  dispose(): void {
    if (this.proximity) {
      try {
        this.proximity.Detach(this);
        console.log('[ProximityAvatarListener] Detached from Proximity');
      } catch (err) {
        console.error('[ProximityAvatarListener] Error detaching from Proximity:', err);
      }
      this.proximity = null;
    }

    this.avatars.clear();
    this.observers.clear();
  }
}
