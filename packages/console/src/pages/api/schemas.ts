import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  isScalarType,
} from 'graphql';
import assert from 'assert';

export const buildDynamicSchema = data => {
  if (!data || typeof data !== 'object') {
    // Return a minimal schema if no data provided
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          placeholder: {
            type: GraphQLString,
            resolve: () => 'No data available',
          },
        },
      }),
    });
  }
  return schemaFromObject(data);
};

function typeFromValue(name, val) {
  let type;
  if (typeof val === 'boolean') {
    type = GraphQLBoolean;
  } else if (typeof val === 'number') {
    type = GraphQLFloat;
  } else if (val instanceof Array && val.length > 0) {
    type = typeFromValue(name + "_child", val[0]);
    type = new GraphQLList(type);
  } else if (typeof val === 'object' && val !== null && Object.keys(val).length > 0) {
    type = objectTypeFromObject(name, val);
  } else {
    type = GraphQLString;
  }
  return type;
}

function typeFromArrayOfValues(name, vals) {
  // Create a subtype or union type from an array of values.
  let obj = {};
  if (false && vals.length > 1) {
    vals.forEach(val => {
      // For now, assume elements are objects.
      assert(typeof val === 'object' && val !== null && !(val instanceof Array));
      Object.keys(val).forEach(key => {
        if (obj[key] === undefined) {
          obj[key] = val[key];
        }
      });
    });
  } else {
    obj = vals[0];
  }
  return typeFromValue(name, obj);
}

function normalizeName(name) {
  return name.replace(/[()\ ]/g, '_');
}

function objectTypeFromObject(name, obj) {
  name = normalizeName(name);
  assert(name !== '0' && name !== '"0"');
  const fields = {};
  const args = {};
  let hasArgs = false;
  Object.keys(obj).forEach(key => {
    const type = typeFromValue(name + '_' + key, obj[key]);
    if (type instanceof GraphQLList && type.ofType instanceof GraphQLObjectType) {
      const fields = type.ofType.getFields();
      Object.keys(fields).forEach(key => {
        const field = fields[key];
        if (isScalarType(field.type)) {
          args[field.name] = {type: field.type};
          hasArgs = true;
        }
      });
    }
    if (type) {
      // If type is object, then add an arg for each child field.
      fields[key] = {
        type: type,
        args: hasArgs && args || undefined,
        resolve(obj, args, context, info) {
          const data = obj[key];
          if (!(data instanceof Array) || Object.keys(args).length === 0) {
            return data;
          }
          const name = Object.keys(args)[0];
          let vals = [];
          data.forEach(child => {
            console.log(`objectTypeFromObject() child[${name}]=` + child[name] + ` args[${name}]=` + args[name]);
            if (child[name] === args[name] ||
                typeof args[name] === 'object' &&
                args[name].min &&
                +child[name] >= +args[name].min) {
              vals.push(child);
            }
          });
          if (vals.length > 0) {
            vals = vals;
          } else {
            vals = undefined;
          }
          return vals;
        },
      };
    }
  });
  return new GraphQLObjectType({
    name: name,
    fields: fields,
  });
}

function schemaFromObject(obj) {
  const type = objectTypeFromObject('root', obj);
  return new GraphQLSchema({
    query: type,
  });
}
