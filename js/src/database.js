// @flow

// Copyright 2016 Attic Labs, Inc. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

import Hash from './hash.js';
import Ref from './ref.js';
import Map from './map.js';
import Set from './set.js';
import type Value from './value.js';
import type {RootTracker} from './chunk-store.js';
import ValueStore from './value-store.js';
import type {BatchStore} from './batch-store.js';
import Commit from './commit.js';
import {equals} from './compare.js';

export default class Database {
  _vs: ValueStore;
  _rt: RootTracker;
  _datasets: Promise<Map<string, Ref<Commit>>>;

  constructor(bs: BatchStore, cacheSize: number = 0) {
    this._vs = new ValueStore(bs, cacheSize);
    this._rt = bs;
    this._datasets = this._datasetsFromRootRef(bs.getRoot());
  }

  _clone(vs: ValueStore, rt: RootTracker): Database {
    const ds = Object.create(Database.prototype);
    ds._vs = vs;
    ds._rt = rt;
    ds._datasets = this._datasetsFromRootRef(rt.getRoot());
    return ds;
  }

  _datasetsFromRootRef(rootRef: Promise<Hash>): Promise<Map<string, Ref<Commit>>> {
    return rootRef.then(rootRef => {
      if (rootRef.isEmpty()) {
        return Promise.resolve(new Map());
      }

      return this.readValue(rootRef);
    });
  }

  headRef(datasetID: string): Promise<?Ref<Commit>> {
    return this._datasets.then(datasets => datasets.get(datasetID));
  }

  head(datasetID: string): Promise<?Commit> {
    return this.headRef(datasetID).then(hr => hr ? this.readValue(hr.targetHash) : null);
  }

  datasets(): Promise<Map<string, Ref<Commit>>> {
    return this._datasets;
  }

  // TODO: This should return Promise<?Value>
  async readValue(hash: Hash): Promise<any> {
    return this._vs.readValue(hash);
  }

  writeValue<T: Value>(v: T): Ref<T> {
    return this._vs.writeValue(v);
  }

  async _descendsFrom(commit: Commit, currentHeadRef: Ref<Commit>): Promise<boolean> {
    let ancestors = commit.parents;
    while (!(await ancestors.has(currentHeadRef))) {
      if (ancestors.isEmpty()) {
        return false;
      }
      ancestors = await getAncestors(ancestors, this);
    }
    return true;
  }

  async commit(datasetId: string, commit: Commit): Promise<Database> {
    const currentRootRefP = this._rt.getRoot();
    const datasetsP = this._datasetsFromRootRef(currentRootRefP);
    let currentDatasets = await (datasetsP:Promise<Map>);
    const currentRootRef = await currentRootRefP;
    const commitRef = this.writeValue(commit);

    if (!currentRootRef.isEmpty()) {
      const currentHeadRef = await currentDatasets.get(datasetId);
      if (currentHeadRef) {
        if (equals(commitRef, currentHeadRef)) {
          return this;
        }
        if (!await this._descendsFrom(commit, currentHeadRef)) {
          throw new Error('Merge needed');
        }
      }
    }

    currentDatasets = await currentDatasets.set(datasetId, commitRef);
    const newRootRef = this.writeValue(currentDatasets).targetHash;
    if (await this._rt.updateRoot(newRootRef, currentRootRef)) {
      return this._clone(this._vs, this._rt);
    }

    throw new Error('Optimistic lock failed');
  }

  close(): Promise<void> {
    return this._vs.close();
  }
}

async function getAncestors(commits: Set<Ref<Commit>>, database: Database):
    Promise<Set<Ref<Commit>>> {
  let ancestors = new Set();
  await commits.map(async (commitRef) => {
    const commit = await database.readValue(commitRef.targetHash);
    await commit.parents.map(async (ref) => ancestors = await ancestors.add(ref));
  });
  return ancestors;
}
