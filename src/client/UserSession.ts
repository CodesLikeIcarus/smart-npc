import { Session } from '../base/Session.js';
import { ConnectionState, MapModelClass } from '../types/index.js';
import type { TeleportDestination } from '../types/index.js';
import { getPFabric, LnGUser, LnGPersona } from '../mv/LnG.js';
import { PersonaSession } from './PersonaSession.js';
import { LoginClient } from './LoginClient.js';

/**
 * UserSession — manages the authenticated user's RUser model and delegates
 * persona lifecycle to PersonaSession.
 *
 * Integrates with @metaversalcorp/mvrp for user/persona protocol handling via
 * the pLnG instance provided by the MSF fabric (getPFabric().pLnG).
 */
export class UserSession extends Session {
  private readonly user: LnGUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pLnG: any;
  private _personaSession: PersonaSession | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pRUser: any;
  private _ownPersonaList: LnGPersona[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _friendsService: any = null;
  private _loginClient: LoginClient | null = null;
  /**
   * Constructor now gets pLnG from MSF fabric via getPFabric().
   * This follows RP1Demo pattern: Model_Open + Attach in constructor.
   */
  constructor(user: LnGUser, anyLoginClient: LoginClient | null = null) {
    super();
    this.user = user;
    this._loginClient = anyLoginClient;

    // Get the real pLnG from MSF fabric (has Model_Open method)
    const pLnG = getPFabric()?.pLnG;
    if (!pLnG) {
      throw new Error('[UserSession] pLnG not available from MSF fabric');
    }
    this.pLnG = pLnG;

    // Model_Open + Attach happen IMMEDIATELY in constructor (RP1Demo pattern)
    console.log(`[UserSession] Opening RUser model for user ${user.id}...`);
    this.pRUser = pLnG.Model_Open('RUser', user.id);
    if (!this.pRUser) {
      throw new Error(`[UserSession] Model_Open('RUser', '${user.id}') returned null`);
    }
    console.log(`[UserSession] RUser model opened, attaching listener`);
    this.pRUser.Attach(this);
  }

  get userId(): string {
    return this.user.id;
  }

  get username(): string {
    return this.user.displayName;
  }

  get ownPersonaList(): LnGPersona[] {
    return this._ownPersonaList;
  }

  /**
   * Initialize the UserSession connection state.
   * Model_Open + Attach already happened in constructor.
   */
  async connect(): Promise<void> {
    this.setState(ConnectionState.Connecting);
    console.log('[UserSession] Connected (pRUser already initialized in constructor)');
    this.setState(ConnectionState.Connected);
  }

  /**
   * Called by MV library when pRUser ready state changes.
   * Enumerates existing personas when RUser is RECOVERED.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onReadyState(pNotice: any): void {
    if (pNotice.pCreator !== this.pRUser) return;

    const readyState = this.pRUser.ReadyState?.();

    console.log('[UserSession] onReadyState fired, readyState:', readyState);

    if (this.pRUser.eSTATE?.RECOVERED !== undefined && readyState === this.pRUser.eSTATE.RECOVERED) {
      console.log('[UserSession] RUser state is RECOVERED, enumerating personas...');
      this.enumeratePersonas();
    }
  }

  /**
   * Enumerate existing personas using Child_Enum like RP1Demo does.
   */
  private enumeratePersonas(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enumCallback = (rPersona: any): boolean => {
      const personaId = rPersona.twRPersonaIx;
      const personaName = rPersona.pName;
      const displayName = [personaName?.wsForename, personaName?.wsSurname]
        .filter(Boolean)
        .join(' ') || `Persona_${personaId}`;

      const persona: LnGPersona = {
        id: String(personaId),
        displayName,
        firstName: personaName?.wsForename || '',
        lastName: personaName?.wsSurname || '',
      };

      this._ownPersonaList.push(persona);
      console.log(`[UserSession] Found persona: ${displayName} (ID: ${personaId})`);

      return true; // Continue enumeration
    };

    try {
      this.pRUser.Child_Enum('RPersona', this, enumCallback);
      console.log(`[UserSession] Persona enumeration complete. Found ${this._ownPersonaList.length} personas`);
    } catch (err) {
      console.error('[UserSession] Child_Enum failed:', err);
    }
  }

  /**
   * Enter the world with the selected persona.
   */
  async pickPersona(personaId: string): Promise<void> {
    const persona = this._ownPersonaList.find((p) => p.id === personaId);
    return new Promise<void>((resolve) =>
      this.setupPersonaSession(personaId, resolve, persona?.firstName, persona?.lastName)
    );
  }

  /**
   * Close the active PersonaSession and the RUser model.
   */
  async disconnect(): Promise<void> {
    this._friendsService = null;

    if (this._personaSession) {
      await this._personaSession.disconnect();
      this._personaSession = null;
    }

    if (this.pRUser) {
      this.pRUser.Detach(this);
    }
    this._ownPersonaList = [];

    this.setState(ConnectionState.Disconnected);
  }

  teleportTo(
    parentId: string,
    position: { x: number; y: number; z: number },
    wClass?: (typeof MapModelClass)[keyof typeof MapModelClass],
  ): void {
    if (!this._personaSession) {
      console.error('[UserSession] No PersonaSession for teleport');
      return;
    }
    this._personaSession.teleportTo(parentId, position, wClass);
  }

  async teleportToDestination(destination: TeleportDestination): Promise<void> {
    if (!this._personaSession) {
      console.error('[UserSession] No PersonaSession for destination teleport');
      return;
    }
    await this._personaSession.teleportToDestination(destination);
  }

  /** Returns the active PersonaSession, or `null` before `pickPersona()` is called. */
  get personaSession(): PersonaSession | null {
    return this._personaSession;
  }

  /**
   * Set up a PersonaSession for the given persona ID,
   * then resolve the enclosing promise once the session is connected.
   */
  private setupPersonaSession(
    id: string,
    resolve: (value: void | PromiseLike<void>) => void,
    firstName?: string,
    lastName?: string
  ): void {
    // Use pLnG from this instance
    this._personaSession = new PersonaSession(id, this.pLnG, this.pRUser, firstName, lastName, this._loginClient);
    void this._personaSession.connect().then(() => {
      this._initFriendsService();
      resolve();
    }).catch((err) => {
      console.error('[UserSession] PersonaSession.connect failed:', err);
      throw err;
    });
  }

  /**
   * Initialize the friends service via pFabric.GetLnG("friends").
   * Uses the Attach/onReadyState event pattern to wait for readiness.
   */
  private _initFriendsService(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pFabric: any = getPFabric();
    if (!pFabric) return;

    const friendsLnG = pFabric.GetLnG('friends');
    if (!friendsLnG) return;

    if (friendsLnG.IsReady()) {
      this._friendsService = friendsLnG;
      return;
    }

    const listener = {
      onReadyState: () => {
        if (friendsLnG.IsReady()) {
          pFabric.Detach(listener);
          this._friendsService = friendsLnG;
        }
      },
    };
    pFabric.Attach(listener);
  }
}