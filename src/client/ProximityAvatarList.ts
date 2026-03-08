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
 * Tracks nearby external avatars by intercepting Proximity's onAvatarUpdate
 * event which provides batch avatar updates with position data.
 * Maintains a sorted list of the 10 closest avatars and notifies observers of changes.
 */
export class ProximityAvatarList {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private proximity: any = null;
  private avatars: Map<number, AvatarInfo> = new Map();
  private localPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private localPersonaID: number | null = null;
  private observers: Set<(avatars: AvatarInfo[]) => void> = new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private originalEmit: any = null;

  /**
   * Initialize and hook into the Proximity instance.
   * Wraps Proximity's Emit method to intercept onAvatarUpdate events.
   *
   * @param proximity The MV.MVRP.Proximity instance from ProximityAudioManager
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init(proximity: any): void {
    if (!proximity) {
      console.warn('[ProximityAvatarList] Proximity instance is null');
      return;
    }

    this.proximity = proximity;
    this.setupProximityInterception();

    console.log('[ProximityAvatarList] Initialized and hooked into Proximity');
  }

  /**
   * Update the local persona's ID and Cartesian position.
   * Called from InWorldSession.teleportTo() whenever the user teleports.
   * This keeps the proximity list synchronized with the actual avatar position.
   *
   * @param personaID The local persona's ID
   * @param position The Cartesian position {x, y, z} in global coordinates
   */
  public updateLocalPosition(personaID: number, position: { x: number; y: number; z: number }): void {
    this.localPersonaID = personaID;
    this.localPosition = { x: position.x, y: position.y, z: position.z };
    console.log('[ProximityAvatarList] Local position updated: persona', personaID, 'at',
      position.x.toFixed(2), position.y.toFixed(2), position.z.toFixed(2));

    // Recalculate distances for all tracked avatars
    this.recalculateDistances();
  }

  /**
   * Recalculate distances for all tracked avatars after local position changes.
   */
  private recalculateDistances(): void {
    let changed = false;
    for (const [, avatar] of this.avatars) {
      const newDistance = this.calculateDistance(avatar.position);
      if (newDistance !== avatar.distance) {
        avatar.distance = newDistance;
        changed = true;
      }
    }

    if (changed) {
      console.log('[ProximityAvatarList] Distances recalculated for', this.avatars.size, 'avatars');
      this.notifyObservers();
    }
  }

  /**
   * Intercept Proximity's Emit method to capture onAvatarUpdate events.
   * Similar to setupDecodeInterception in ProximityAudioManager.
   */
  private setupProximityInterception(): void {
    if (!this.proximity || typeof this.proximity.Emit !== 'function') {
      console.warn('[ProximityAvatarList] Proximity.Emit not found');
      return;
    }

    // Store original Emit method
    this.originalEmit = this.proximity.Emit;

    // Wrap Emit to intercept events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this;
    this.proximity.Emit = function (eventName: string, ...args: any[]): any {
      // Call original first
      const result = self.originalEmit.apply(this, [eventName, ...args]);

      // Intercept onAvatarUpdate event
      if (eventName === 'onAvatarUpdate' && args.length > 0) {
        const eventData = args[0];
        ///console.log('[ProximityAvatarList] Intercepted onAvatarUpdate');
        self.handleAvatarUpdate(eventData);
      } else if (eventName === 'onModelClose' && args.length > 0) {
        const dwRPersonaIx = args[0];
        console.log('[ProximityAvatarList] Intercepted onModelClose:', dwRPersonaIx);
        self.onModelClose(dwRPersonaIx);
      } else if (eventName === 'onModelHide' && args.length > 0) {
        const dwRPersonaIx = args[0];
        console.log('[ProximityAvatarList] Intercepted onModelHide:', dwRPersonaIx);
        self.onModelHide(dwRPersonaIx);
      } else if (eventName === 'onUserReady' && args.length >= 5) {
        const [, dwRPersonaIx, nX, nY, nZ] = args;
        console.log('[ProximityAvatarList] Intercepted onUserReady:', dwRPersonaIx);
        self.updateLocalPosition(dwRPersonaIx, { x: nX, y: nY, z: nZ });
      } else if (eventName === 'onLogout_Client') {
        console.log('[ProximityAvatarList] Intercepted onLogout_Client');
        self.onLogout_Client(args[0] || false);
      }

      return result;
    };

    console.log('[ProximityAvatarList] Wrapped Proximity.Emit for event interception');
  }

  /**
   * Handle onAvatarUpdate event with batch avatar data.
   * The event contains:
   * - aSBA_RProximity_Avatar_Open_Ex: Array of persona IDs
   * - SBA_RProximity_Avatar_Update_Ex: Avatar state with position data
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleAvatarUpdate(eventData: any): void {
    if (!eventData) return;

    const avatarOpenExArray = eventData.aSBA_RProximity_Avatar_Open_Ex;
    const avatarUpdateEx = eventData.SBA_RProximity_Avatar_Update_Ex;

    if (!avatarUpdateEx) {
      console.warn('[ProximityAvatarList] No avatar update data in event');
      return;
    }

    const dwRPersonaIx = avatarUpdateEx.twRPersonaIx;

    // Skip the local avatar
    if (dwRPersonaIx === this.localPersonaID) {
      return;
    }

    ///console.log('[ProximityAvatarList] Processing avatar update for:', dwRPersonaIx);

    // Extract position from pState.pPosition_Head.pRelative.vPosition
    const pState = avatarUpdateEx.pState;
    if (!pState || !pState.pPosition_Head) {
      console.warn('[ProximityAvatarList] No position data in avatar update');
      return;
    }

    const positionHead = pState.pPosition_Head;
    const vPosition = positionHead?.pRelative?.vPosition;

    if (!vPosition) {
      console.warn('[ProximityAvatarList] No vPosition in pPosition_Head');
      return;
    }

    // vPosition has dX, dY, dZ (world coordinates)
    const position = {
      x: vPosition.dX,
      y: vPosition.dY,
      z: vPosition.dZ,
    };

    const distance = this.calculateDistance(position);

    // Determine if this is a new avatar (first appearance)
    const isNew = !this.avatars.has(dwRPersonaIx);

    // Get name from avatarOpenExArray if available
    let name = 'Unknown';
    if (avatarOpenExArray && Array.isArray(avatarOpenExArray)) {
      // avatarOpenExArray contains persona IDs in the batch update
      // If this is a new avatar, we might have name data
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const avatarOpenEx = avatarOpenExArray.find((a: any) => a.twRPersonaIx === dwRPersonaIx);
      if (avatarOpenEx && avatarOpenEx.Name) {
        const forename = avatarOpenEx.Name.wszForename || '';
        const surname = avatarOpenEx.Name.wszSurname || '';
        name = (forename + ' ' + surname).trim() || 'Unknown';
      }
    }

    // Preserve existing name if this is an update, not new
    if (!isNew) {
      const existing = this.avatars.get(dwRPersonaIx);
      if (existing) {
        name = existing.name;
      }
    }

    this.avatars.set(dwRPersonaIx, {
      personaID: dwRPersonaIx,
      name,
      position,
      distance,
    });

    ///console.log('[ProximityAvatarList] Avatar updated:', dwRPersonaIx, name, distance.toFixed(2) + 'm', isNew ? '(NEW)' : '(UPDATE)');
    this.notifyObservers();
  }

  /**
   * Proximity callback: External avatar has been removed from the world.
   * Called by Proximity when avatar leaves proximity/world.
   */
  onModelClose(dwRPersonaIx: number): void {
    // Skip the local avatar
    if (dwRPersonaIx === this.localPersonaID) {
      return;
    }

    console.log('[ProximityAvatarList] onModelClose:', dwRPersonaIx);

    if (this.avatars.has(dwRPersonaIx)) {
      this.avatars.delete(dwRPersonaIx);
      this.notifyObservers();
    }
  }

  /**
   * Avatar event callback: External avatar has gone out of range (hidden).
   */
  onModelHide(dwRPersonaIx: number): void {
    // Skip the local avatar
    if (dwRPersonaIx === this.localPersonaID) {
      return;
    }

    console.log('[ProximityAvatarList] onModelHide:', dwRPersonaIx);

    if (this.avatars.has(dwRPersonaIx)) {
      this.avatars.delete(dwRPersonaIx);
      this.notifyObservers();
    }
  }

  /**
   * Avatar event callback: User has logged out.
   * Clear all tracked avatars.
   */
  onLogout_Client(bVoluntary: boolean): void {
    console.log('[ProximityAvatarList] onLogout_Client:', bVoluntary);
    this.avatars.clear();
    this.localPersonaID = null;
    this.notifyObservers();
  }

  /**
   * Calculate Euclidean distance from local avatar to remote avatar.
   * Handles world coordinates (dX, dY, dZ format).
   */
  private calculateDistance(position: { x: number; y: number; z: number }): number {
    const dx = position.x - this.localPosition.x;
    const dy = position.y - this.localPosition.y;
    const dz = position.z - this.localPosition.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get the 10 closest avatars, sorted by distance.
   */
  getClosestAvatars(count: number = 10): AvatarInfo[] {
    return Array.from(this.avatars.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);
  }

  /**
   * Register an observer to be notified when the avatar list changes.
   */
  addObserver(callback: (avatars: AvatarInfo[]) => void): void {
    this.observers.add(callback);
  }

  /**
   * Remove an observer.
   */
  removeObserver(callback: (avatars: AvatarInfo[]) => void): void {
    this.observers.delete(callback);
  }

  /**
   * Notify all observers of avatar list changes.
   */
  private notifyObservers(): void {
    const closestAvatars = this.getClosestAvatars(10);
    for (const observer of this.observers) {
      observer(closestAvatars);
    }
  }

  /**
   * Clean up: Unwrap Proximity if needed.
   */
  dispose(): void {
    if (this.proximity && this.originalEmit) {
      try {
        this.proximity.Emit = this.originalEmit;
        console.log('[ProximityAvatarList] Unwrapped Proximity.Emit');
      } catch (err) {
        console.error('[ProximityAvatarList] Error during cleanup:', err);
      }
    }
    this.avatars.clear();
    this.observers.clear();
    this.proximity = null;
    this.originalEmit = null;
  }
}
